#!/bin/bash

# A Raycast Script Command that opens the board. Written in English on purpose: this file ships in
# the package, and the @raycast lines below are not prose — Raycast parses them, and without
# @raycast.title it refuses to register the command at all.
# Install once, in the Raycast UI:
#   1. Raycast -> Settings -> Extensions -> Script Commands -> "Add Script Directory"
#      -> pick this folder (.../local-kanban/scripts/raycast).
#   2. Find "Open Kanban" in Raycast -> Cmd+K -> "Configure Command" -> "Record Hotkey".
# After that the hotkey opens the board from any application.
# Running on a different port: change the address on the last line.
# @raycast.schemaVersion 1
# @raycast.title Open Kanban
# @raycast.mode silent
# @raycast.packageName local-kanban
# @raycast.icon 📋
# @raycast.description Open the local kanban board (localhost:3100)
open "http://localhost:3100"
