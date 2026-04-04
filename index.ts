/**
 * Background Tasks Extension with Ctrl+B Support
 * 
 * Enhances bash tool to support backgrounding with Ctrl+Shift+B:
 * - Run bash commands normally with streaming output
 * - Press Ctrl+Shift+B during execution to send to background
 * - Process continues running while you regain control
 * - Get notifications when background jobs complete
 * - Manage background jobs with /jobs command and tools
 */

import { spawn, ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface BackgroundJob {
  id: string;
  command: string;
  pid: number;
  startTime: number;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  output: string;
  proc?: ChildProcess;
  toolCallId: string;
}

interface RunningProcess {
  toolCallId: string;
  proc: ChildProcess;
  command: string;
  backgrounded: boolean;
  onUpdate?: (result: any) => void;
  resolve?: (result: any) => void;
  reject?: (error: Error) => void;
}

export default function (pi: ExtensionAPI) {
  const backgroundJobs = new Map<string, BackgroundJob>();
  const runningProcesses = new Map<string, RunningProcess>();
  let jobCounter = 0;

  // Track currently running bash processes
  let currentlyRunningToolCallId: string | null = null;

  // Override the bash tool to support backgrounding
  const originalBashTool = createBashTool(process.cwd());

  pi.registerTool({
    ...originalBashTool,
    name: "bash",
    
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      
      return new Promise<any>((resolve, reject) => {
        // Spawn the process
        const proc = spawn('bash', ['-c', command], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: ctx.cwd,
          detached: true, // Allow process to continue independently
          env: { ...process.env }, // Inherit environment
        });

        if (!proc.pid) {
          reject(new Error("Failed to spawn process"));
          return;
        }

        // Track this running process
        const runningProcess: RunningProcess = {
          toolCallId,
          proc,
          command,
          backgrounded: false,
          onUpdate,
          resolve,
          reject,
        };

        runningProcesses.set(toolCallId, runningProcess);
        currentlyRunningToolCallId = toolCallId;

        let output = '';
        let hasOutput = false;

        // Collect output
        proc.stdout?.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          hasOutput = true;

          // Stream updates if not backgrounded
          if (!runningProcess.backgrounded && onUpdate) {
            onUpdate({
              content: [{ type: "text", text: output }],
              details: { partial: true },
            });
          }
        });

        proc.stderr?.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          hasOutput = true;

          // Stream updates if not backgrounded
          if (!runningProcess.backgrounded && onUpdate) {
            onUpdate({
              content: [{ type: "text", text: output }],
              details: { partial: true },
            });
          }
        });

        // Handle process completion
        proc.on('close', (code) => {
          runningProcesses.delete(toolCallId);
          if (currentlyRunningToolCallId === toolCallId) {
            currentlyRunningToolCallId = null;
          }

          const result = {
            content: [{ type: "text", text: output || "(no output)" }],
            details: {
              exitCode: code || 0,
              command,
              backgrounded: runningProcess.backgrounded,
            },
          };

          if (runningProcess.backgrounded) {
            // Update background job status
            const job = Array.from(backgroundJobs.values())
              .find(j => j.toolCallId === toolCallId);
            if (job) {
              job.status = (code === 0) ? 'completed' : 'failed';
              job.exitCode = code || 0;
              job.output = output;
              delete job.proc;

              // Notify completion
              const duration = Math.round((Date.now() - job.startTime) / 1000);
              const statusText = `Background job ${job.id} ${job.status} (${duration}s)`;
              ctx.ui.notify(
                statusText,
                job.status === 'completed' ? 'success' : 'error'
              );

              // Also notify the agent via message (only for failures)
              if (job.status === 'failed') {
                setTimeout(() => {
                  pi.sendMessage({
                    customType: "job-completion",
                    content: `🔄 ${statusText}\nCommand: ${job.command}`,
                    display: true,
                  }, {
                    deliverAs: "followUp",
                    triggerTurn: false,
                  });
                }, 0);
              }
              
              updateJobsWidget(ctx);
            }
          } else {
            // Normal completion - resolve the tool call
            resolve(result);
          }
        });

        proc.on('error', (err) => {
          runningProcesses.delete(toolCallId);
          if (currentlyRunningToolCallId === toolCallId) {
            currentlyRunningToolCallId = null;
          }

          if (runningProcess.backgrounded) {
            // Handle background job error
            const job = Array.from(backgroundJobs.values())
              .find(j => j.toolCallId === toolCallId);
            if (job) {
              job.status = 'failed';
              job.output += `\nProcess error: ${err.message}`;
              delete job.proc;
              
              const errorText = `Background job ${job.id} failed: ${err.message}`;
              ctx.ui.notify(errorText, 'error');

              // Also notify the agent via message (errors always reported)
              setTimeout(() => {
                pi.sendMessage({
                  customType: "job-completion",
                  content: `❌ ${errorText}\nCommand: ${job.command}`,
                  display: true,
                }, {
                  deliverAs: "followUp",
                  triggerTurn: false,
                });
              }, 0);

              updateJobsWidget(ctx);
            }
          } else {
            reject(err);
          }
        });

        // Handle abort signal (for normal cancellation)
        if (signal) {
          signal.addEventListener('abort', () => {
            if (!runningProcess.backgrounded) {
              proc.kill('SIGTERM');
              runningProcesses.delete(toolCallId);
              if (currentlyRunningToolCallId === toolCallId) {
                currentlyRunningToolCallId = null;
              }
              reject(new Error('Command cancelled'));
            }
          });
        }

        // Initial output update
        if (!hasOutput) {
          setTimeout(() => {
            if (!runningProcess.backgrounded && onUpdate && !hasOutput) {
              onUpdate({
                content: [{ type: "text", text: "Command started..." }],
                details: { partial: true },
              });
            }
          }, 100);
        }
      });
    },
  });

  // Register Ctrl+J shortcut for quick jobs access
  pi.registerShortcut("ctrl+j", {
    description: "Open background jobs interface",
    handler: async (ctx) => {
      await showJobsInterface(ctx);
    },
  });

  // Register Ctrl+Shift+B shortcut to background current process
  pi.registerShortcut("ctrl+shift+b", {
    description: "Background current bash process",
    handler: async (ctx) => {
      if (!currentlyRunningToolCallId) {
        ctx.ui.notify("No running bash process to background", "warning");
        return;
      }

      const runningProcess = runningProcesses.get(currentlyRunningToolCallId);
      if (!runningProcess || runningProcess.backgrounded) {
        ctx.ui.notify("No active process to background", "warning");
        return;
      }

      // Background the process
      backgroundProcess(runningProcess, ctx);
    },
  });

  function backgroundProcess(runningProcess: RunningProcess, ctx: ExtensionContext) {
    const jobId = `job-${++jobCounter}`;
    const job: BackgroundJob = {
      id: jobId,
      command: runningProcess.command,
      pid: runningProcess.proc.pid!,
      startTime: Date.now(),
      status: 'running',
      output: '',
      proc: runningProcess.proc,
      toolCallId: runningProcess.toolCallId,
    };

    // Mark as backgrounded
    runningProcess.backgrounded = true;
    backgroundJobs.set(jobId, job);
    
    // Clear current tracking
    currentlyRunningToolCallId = null;

    // Resolve the original tool call immediately with backgrounded status
    if (runningProcess.resolve) {
      runningProcess.resolve({
        content: [{
          type: "text",
          text: `Process backgrounded as ${jobId}\nCommand: ${runningProcess.command}\nPID: ${job.pid}`
        }],
        details: {
          backgrounded: true,
          jobId,
          pid: job.pid,
          command: runningProcess.command,
        },
      });
    }

    ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
    // Remove updateJobsWidget call - UI operations during critical operations interfere with conversation flow
  }

  // Minimal jobs tool to isolate conversation flow issue
  pi.registerTool({
    name: "jobs",
    label: "Background Jobs",
    description: "List background jobs (minimal version for debugging)",
    parameters: Type.Object({
      action: Type.Literal("list"),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Absolute minimal logic - just count jobs
      const count = backgroundJobs.size;
      
      return {
        content: [{ 
          type: "text", 
          text: `Found ${count} background jobs` 
        }],
        details: { count },
      };
    },
  });

  // Shared function for job management interface
  async function showJobsInterface(ctx: ExtensionContext) {
    const jobs = Array.from(backgroundJobs.values());
    
    if (jobs.length === 0) {
      ctx.ui.notify("No background jobs", "info");
      return;
    }

    const choice = await ctx.ui.select(
      "Background Jobs",
      jobs.map(job => {
        const duration = Math.round((Date.now() - job.startTime) / 1000);
        const status = job.status === 'running' ? `⏳ (${duration}s)` 
                     : job.status === 'completed' ? '✅'
                     : '❌';
        return `${status} ${job.id}: ${job.command.slice(0, 40)}`;
      })
    );
    
    if (choice !== undefined) {
      const job = jobs[choice];
      const actions = job.status === 'running' 
        ? ["Show Output", "Kill Job"]
        : ["Show Output", "Remove from List"];
        
      const action = await ctx.ui.select(`Job: ${job.id}`, actions);
      
      if (action === 0) { // Show Output
        const text = job.output || "(no output yet)";
        const fullText = `Job: ${job.id}\nCommand: ${job.command}\nStatus: ${job.status}\nPID: ${job.pid}\nStarted: ${new Date(job.startTime).toLocaleString()}\n\n--- OUTPUT ---\n${text}`;
        await ctx.ui.editor(`Output for ${job.id}`, fullText);
      } else if (action === 1) {
        if (job.status === 'running' && job.proc) { // Kill
          job.proc.kill('SIGTERM');
          ctx.ui.notify(`Killed job ${job.id}`, "info");
        } else { // Remove
          backgroundJobs.delete(job.id);
          ctx.ui.notify(`Removed job ${job.id}`, "info");
        }
        // Remove updateJobsWidget call - UI operations during tool execution interfere with conversation flow
      }
    }
  }

  // Interactive command for job management
  pi.registerCommand("jobs", {
    description: "Show and manage background jobs interactively",
    handler: async (args, ctx) => {
      await showJobsInterface(ctx);
    },
  });

  // Direct background bash tool for planned backgrounding
  pi.registerTool({
    name: "bash_bg", 
    label: "Background Bash",
    description: "Run bash command in background immediately (doesn't stream to foreground)",
    promptSnippet: "Run bash command in background without blocking conversation",
    promptGuidelines: [
      "Use this when you want to start a long-running command in background immediately",
      "Different from regular bash + Ctrl+B - this backgrounds from the start"
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Command to run in background" }),
      notify: Type.Optional(Type.Boolean({ description: "Notify when complete (default: true)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const jobId = `job-${++jobCounter}`;
      const shouldNotify = params.notify !== false;

      // Spawn background process immediately
      const proc = spawn('bash', ['-c', params.command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ctx.cwd,
        detached: true, // Allow process to continue independently
        env: { ...process.env }, // Inherit environment
      });

      if (!proc.pid) {
        throw new Error("Failed to spawn background process");
      }

      const job: BackgroundJob = {
        id: jobId,
        command: params.command,
        pid: proc.pid,
        startTime: Date.now(),
        status: 'running',
        output: '',
        proc,
        toolCallId,
      };

      backgroundJobs.set(jobId, job);

      // Collect output
      proc.stdout?.on('data', (data) => {
        job.output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        job.output += data.toString();
      });

      // Handle completion
      proc.on('close', (code) => {
        job.status = (code === 0) ? 'completed' : 'failed';
        job.exitCode = code || 0;
        delete job.proc;

        if (shouldNotify) {
          const duration = Math.round((Date.now() - job.startTime) / 1000);
          const statusText = `Background job ${jobId} ${job.status} (${duration}s)`;
          ctx.ui.notify(
            statusText,
            job.status === 'completed' ? 'success' : 'error'
          );

          // Also notify the agent via message (only for failures)
          if (job.status === 'failed') {
            setTimeout(() => {
              pi.sendMessage({
                customType: "job-completion",
                content: `🔄 ${statusText}\nCommand: ${job.command}`,
                display: true,
              }, {
                deliverAs: "followUp",
                triggerTurn: false,
              });
            }, 0);
          }
        }
        
        // Remove updateJobsWidget call - UI operations in async handlers interfere with conversation flow
      });

      proc.on('error', (err) => {
        job.status = 'failed';
        job.output += `\nProcess error: ${err.message}`;
        delete job.proc;
        
        if (shouldNotify) {
          const errorText = `Background job ${jobId} failed: ${err.message}`;
          ctx.ui.notify(errorText, 'error');

          // Also notify the agent via message (errors always reported)
          setTimeout(() => {
            pi.sendMessage({
              customType: "job-completion",
              content: `❌ ${errorText}\nCommand: ${job.command}`,
              display: true,
            }, {
              deliverAs: "followUp",
              triggerTurn: false,
            });
          }, 0);
        }
        
        // Remove updateJobsWidget call - UI operations in async handlers interfere with conversation flow
      });

      // Remove updateJobsWidget call - UI operations during tool execution interfere with conversation flow

      return {
        content: [{ 
          type: "text", 
          text: `Started background job ${jobId}\nCommand: ${params.command}\nPID: ${proc.pid}` 
        }],
        details: { jobId, pid: proc.pid, command: params.command },
      };
    },
  });

  function updateJobsWidget(ctx: ExtensionContext) {
    const runningJobs = Array.from(backgroundJobs.values())
      .filter(job => job.status === 'running');

    if (runningJobs.length === 0) {
      ctx.ui.setWidget("background-jobs", undefined);
      ctx.ui.setStatus("background-jobs", undefined);
      return;
    }

    // Widget showing job details
    const lines = runningJobs.map(job => {
      const duration = Math.round((Date.now() - job.startTime) / 1000);
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
      return `⏳ ${job.id}: ${job.command.slice(0, 35)} (${timeStr})`;
    });

    ctx.ui.setWidget("background-jobs", lines, { 
      placement: "aboveEditor" 
    });

    // Status bar summary
    const completedJobs = Array.from(backgroundJobs.values())
      .filter(job => job.status === 'completed').length;
    const failedJobs = Array.from(backgroundJobs.values())
      .filter(job => job.status === 'failed').length;
    
    let statusText = `${runningJobs.length} running`;
    if (completedJobs > 0) statusText += `, ${completedJobs} done`;
    if (failedJobs > 0) statusText += `, ${failedJobs} failed`;
    
    ctx.ui.setStatus("background-jobs", ctx.ui.theme.fg("accent", `🔄 ${statusText}`));
  }

  // Persistence: save state to session entries
  function persistState() {
    pi.appendEntry("background-tasks-state", {
      jobs: Array.from(backgroundJobs.entries()).map(([id, job]) => [id, {
        ...job,
        proc: undefined, // Don't serialize process objects
      }]),
      jobCounter,
    });
  }

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    // Restore state from session entries
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "background-tasks-state") {
        const data = entry.data as any;
        if (data.jobs) {
          // Only restore completed/failed jobs (running jobs can't be restored)
          for (const [id, jobData] of data.jobs) {
            if (jobData.status !== 'running') {
              backgroundJobs.set(id, jobData);
            }
          }
        }
        if (typeof data.jobCounter === 'number') {
          jobCounter = Math.max(jobCounter, data.jobCounter);
        }
        break;
      }
    }
    
    updateJobsWidget(ctx);
  });

  // Only persist on shutdown to avoid interfering with conversation flow
  pi.on("session_shutdown", async () => {
    // Kill all running background jobs
    for (const job of backgroundJobs.values()) {
      if (job.proc && job.status === 'running') {
        job.proc.kill('SIGTERM');
      }
    }
    persistState();
  });
}