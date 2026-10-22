#!/bin/sh
# Cursor runs a plugin hook as a script: this one hands the event to the plugin's hook.mjs (see it)
exec node "$(dirname "$0")/hook.mjs" cursor stop --record
