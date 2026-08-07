// ── js/features/smart-paste.js ───────────────────────────────
// Paste indented/bullet text → mindmap node tree
import { state, $cv, pushUndo, selectedNodes, refs, COLORS } from '../state.js';
import { renderLines, syncColors, addConnection }                  from '../canvas/connection.js';
import { buildEl }                                                 from '../canvas/node.js';
import { flash }                                                   from '../ui/flash.js';
import { updateSelectionUI }                                       from '../canvas/selection.js';

const INDENT_UNIT = 150; // px between levels horizontally
const ROW_H       = 80;  // px per row vertically

/**
 * Detect indent level of a line.
 * Supports: tabs (1 tab = 1 level) or spaces (every 2 spaces = 1 level)
 */
function indentLevel(line) {
  let i = 0;
  if (line[0] === '\t') {
    while (line[i] === '\t') i++;
    return i;
  }
  while (line[i] === ' ') i++;
  return Math.floor(i / 2);
}

/** Strip leading whitespace, common bullet chars, and markdown list markers */
function cleanLine(line) {
  return line
    .replace(/^[\s\t]+/, '')         // leading whitespace
    .replace(/^[-*+•·▪▸▶►→]\s*/, '') // bullet/arrow chars
    .replace(/^\d+[.)]\s+/, '')       // "1. " or "1) " numbered lists
    .trim();
}

/**
 * Detect if text looks like an indented list (≥2 non-empty lines,
 * at least one line has leading whitespace or is a list item).
 */
export function looksLikeTree(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  if (lines.length < 2) return false;
  const hasIndent = lines.some(l => /^[\t ]/.test(l));
  const hasBullet = lines.some(l => /^[-*+•·▪▸▶►→]/.test(l.trim()));
  return hasIndent || hasBullet;
}

/**
 * Parse indented text into a flat list of { level, text } items.
 */
function parseLines(text) {
  return text
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim())
    .map(l => ({ level: indentLevel(l), text: cleanLine(l) }))
    .filter(item => item.text);
}

/**
 * Create a tree of nodes from parsed items.
 * Returns [rootId, ...createdIds]
 */
export function smartPaste(text, anchorX, anchorY) {
  const items = parseLines(text);
  if (!items.length) { flash('Tidak ada teks untuk ditempel', false); return; }

  pushUndo();

  // Build column grouping: group items into roots (level-0 subtrees)
  // Place each level-0 item at different x columns, children cascade right
  const createdIds = [];
  selectedNodes.clear();

  // Stack: each entry is { level, id, yNext }
  // yNext tracks the next free y position for children of this node
  const stack = [];       // [ {level, id} ]
  const levelY = {};      // per-level: next y to place a node
  levelY[0] = anchorY;

  let col0NodeCount = 0;

  for (let i = 0; i < items.length; i++) {
    const { level, text } = items[i];

    // x: based on level
    const x = anchorX + level * INDENT_UNIT;
    // y: increment per level independently
    if (levelY[level] === undefined) levelY[level] = anchorY;
    const y = levelY[level];
    levelY[level] += ROW_H;
    // Also push children levels down
    for (let l = level + 1; l <= 20; l++) {
      if (levelY[l] !== undefined && levelY[l] < y + ROW_H) levelY[l] = y + ROW_H;
    }

    // Create node
    const id = 'n' + (state.nextId++);
    state.nodes[id] = { id, text, x, y, children: [], note: '' };
    const el = buildEl(state.nodes[id]);
    $cv.appendChild(el);
    COLORS.forEach((c, ci) => { if (ci === 0) el.style.borderColor = c; });

    createdIds.push(id);
    selectedNodes.add(id);

    // Pop stack to find parent (stack top with level < current)
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();

    if (stack.length) {
      const parentId = stack[stack.length - 1].id;
      addConnection(parentId, id);
    }

    stack.push({ level, id });
  }

  syncColors();
  renderLines();
  updateSelectionUI();
  refs.dirty = true;
  flash(`✓ ${createdIds.length} node ditempel dari teks`, true);
  return createdIds;
}
