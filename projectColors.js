const fs = require('fs');
const path = require('path');
const os = require('os');

// Color palette - works well for title bars in both light/dark modes
const COLOR_PALETTE = [
  { id: 'slate', hex: '#475569', name: 'Slate' },
  { id: 'rose', hex: '#be123c', name: 'Rose' },
  { id: 'amber', hex: '#b45309', name: 'Amber' },
  { id: 'emerald', hex: '#047857', name: 'Emerald' },
  { id: 'sky', hex: '#0369a1', name: 'Sky' },
  { id: 'violet', hex: '#7c3aed', name: 'Violet' },
  { id: 'teal', hex: '#0f766e', name: 'Teal' },
  { id: 'fuchsia', hex: '#a21caf', name: 'Fuchsia' }
];

const CONFIG_FILE = path.join(os.homedir(), '.janus-colors.json');

// In-memory cache of color assignments
let colorAssignments = {};

// Load color assignments from disk
function loadColorAssignments() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      colorAssignments = JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load color assignments:', err);
    colorAssignments = {};
  }
  return colorAssignments;
}

// Save color assignments to disk
function saveColorAssignments() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(colorAssignments, null, 2));
  } catch (err) {
    console.error('Failed to save color assignments:', err);
  }
}

// Get a random color ID from the palette
function getRandomColorId() {
  const index = Math.floor(Math.random() * COLOR_PALETTE.length);
  return COLOR_PALETTE[index].id;
}

// Get the color hex for a project path (assigns random if new)
function getProjectColor(projectPath) {
  if (!projectPath) {
    return COLOR_PALETTE[0].hex; // Default to slate for no project
  }

  // Normalize path for consistent lookup
  const normalizedPath = path.normalize(projectPath);

  if (!colorAssignments[normalizedPath]) {
    colorAssignments[normalizedPath] = getRandomColorId();
    saveColorAssignments();
  }

  const colorId = colorAssignments[normalizedPath];
  const color = COLOR_PALETTE.find(c => c.id === colorId);
  return color ? color.hex : COLOR_PALETTE[0].hex;
}

// Get the color ID for a project path
function getProjectColorId(projectPath) {
  if (!projectPath) {
    return COLOR_PALETTE[0].id;
  }

  const normalizedPath = path.normalize(projectPath);
  return colorAssignments[normalizedPath] || COLOR_PALETTE[0].id;
}

// Set the color for a project path
function setProjectColor(projectPath, colorId) {
  if (!projectPath) return false;

  const color = COLOR_PALETTE.find(c => c.id === colorId);
  if (!color) return false;

  const normalizedPath = path.normalize(projectPath);
  colorAssignments[normalizedPath] = colorId;
  saveColorAssignments();
  return true;
}

// Get color hex by ID
function getColorHex(colorId) {
  const color = COLOR_PALETTE.find(c => c.id === colorId);
  return color ? color.hex : COLOR_PALETTE[0].hex;
}

// Initialize by loading saved assignments
loadColorAssignments();

module.exports = {
  COLOR_PALETTE,
  getProjectColor,
  getProjectColorId,
  setProjectColor,
  getColorHex,
  loadColorAssignments
};
