#!/bin/bash
# Tau statusline wrapper: captures Claude Code's statusline stdin JSON
# (rate_limits + context + model) to a file for tau's quota monitoring,
# then passes stdin through to the original statusline command unchanged.
input=$(cat)
printf '%s' "$input" > /tmp/cc-statusline-input.json 2>/dev/null
original="$(cat "$HOME/.pi/agent/extensions/tau/.statusline-original" 2>/dev/null)"
if [ -n "$original" ]; then
    printf '%s' "$input" | eval "$original" 2>/dev/null
fi
