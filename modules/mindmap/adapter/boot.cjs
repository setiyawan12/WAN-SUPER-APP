'use strict';

const path = require('node:path');

let handle = null;

async function bootMindmap(opts = {}) {
  const show = opts.show !== false;
  const embedOnly = !!opts.embedOnly;

  if (handle) {
    if (show && !embedOnly) handle.show();
    return handle;
  }

  const moduleRoot = opts.moduleRoot || path.join(__dirname, '..');
  const mindmap = require(path.join(moduleRoot, 'main/index.cjs'));
  mindmap.initMindmap();
  if (show && !embedOnly) mindmap.openMindmapWindow();

  handle = {
    id: 'mindmap',
    show: () => mindmap.openMindmapWindow(),
    hide: () => mindmap.hideMindmapWindow(),
    presentIn: (win) => mindmap.attachMindmapWindow(win),
    shutdown: async () => {
      mindmap.shutdownMindmap();
      handle = null;
    },
    isRunning: () => true,
    getStatus: () => mindmap.getMindmapStatus(),
  };

  return handle;
}

module.exports = { bootMindmap };