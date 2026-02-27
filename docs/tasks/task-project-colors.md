# Task: Project-Based Title Bar Colors

## Overview
Add support for colorful title bars that differ based on the project folder. Each project folder gets assigned a color (random from palette if new), and users can change the color via Window > Project Color menu.

## Requirements
1. Use `titleBarStyle: 'hidden'` with `titleBarOverlay` for macOS to allow custom title bar colors
2. Create a color palette that works well in both light and dark modes
3. Persist color assignments per project path in a JSON config file
4. Add menu: Window > Project Color with submenu of all palette colors
5. Random assignment for new folders, with ability to override via menu

## Color Palette Design
Colors should be:
- Visually distinct from each other
- Work well as title bar backgrounds (not too bright, not too dark)
- Have enough contrast for white traffic light symbols

Proposed palette (8 colors):
- Slate (#475569) - neutral gray-blue
- Rose (#be123c) - deep rose/red
- Amber (#b45309) - warm orange-brown
- Emerald (#047857) - forest green
- Sky (#0369a1) - ocean blue
- Violet (#7c3aed) - purple
- Teal (#0f766e) - teal/cyan
- Fuchsia (#a21caf) - magenta/pink

## Implementation Plan

### 1. Color Configuration Module
Create `projectColors.js`:
- Define color palette with name, hex value, and display name
- Load/save color assignments from `~/.janus-colors.json`
- Function to get color for project path (assign random if new)
- Function to set color for project path

### 2. Modify main.js
- Import color module
- Update `createWindow()` to use:
  ```javascript
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: getProjectColor(projectPath),
    symbolColor: '#ffffff',
    height: 40
  }
  ```
- Update `select-project-folder` handler to update title bar color when folder changes
- Add IPC handler for changing project color

### 3. Add Window > Project Color Menu
- Replace `{ role: 'windowMenu' }` with custom Window menu
- Add "Project Color" submenu with all palette colors
- Include checkmark on current color
- On selection: save color, update window's title bar overlay

### 4. Menu Update on Focus
- Track which color is selected per window
- Update menu checkmarks when window gains focus

## Files to Modify
- `main.js` - window creation, menu, IPC handlers
- New: `projectColors.js` - color management module

## Testing
- Open window with no project - should get random color
- Open window with project - should get consistent color
- Change color via menu - should update immediately
- Restart app - colors should persist
- Open same project in new window - should use saved color
