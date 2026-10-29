
import './js/init.js';
import { state, api, retryUnsaved } from './js/core.js';
import { refresh } from './js/sse.js';
import { loadProjects, loadTasks, openFolderPicker, renderFolderBrowser, retryLoad, selectProject, styledConfirm, styledPrompt } from './js/sidebar.js';
import { openDrawer, closeDrawer, deleteTask, cancelTask, setKbCursor } from './js/drawer.js';
import { openProjectSettings, closeProjectSettings } from './js/project.js';
import { openSettingsModal, getSetting, setSetting, applyTheme } from './js/settings.js';
import { renderDashboard } from './js/dash.js';
import { renderNow } from './js/now.js';
import { renderReview } from './js/review.js';
import { renderDone } from './js/done.js';
import { applyAutomations, renderAutomations } from './js/automations.js';
import { renderHealth } from './js/health.js';
import { checkVersion } from './js/init.js';
import { applyLimits, renderLimits } from './js/limits.js';
import { applyAskEvent, renderAsks } from './js/asks.js';
import { renderBoard } from './js/board.js';
import { openOnboarding } from './js/onboarding.js';

Object.assign(window, {
  state, api, refresh, loadTasks, loadProjects, selectProject,
  openDrawer, closeDrawer, deleteTask, cancelTask, setKbCursor,
  openProjectSettings, closeProjectSettings, openSettingsModal, getSetting, setSetting, applyTheme,
  renderDashboard, renderNow, renderReview, renderDone, renderAutomations, applyAutomations, renderHealth, openOnboarding, styledConfirm, styledPrompt, checkVersion,
  openFolderPicker, renderFolderBrowser,
  applyLimits, renderLimits,
  applyAskEvent, renderAsks,
  retryUnsaved,
  retryLoad,
  renderBoard,
});
