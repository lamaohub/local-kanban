
import './js/init.js';
import { state, api } from './js/core.js';
import { refresh } from './js/sse.js';
import { selectProject, loadProjects, loadTasks, styledConfirm, styledPrompt } from './js/sidebar.js';
import { openDrawer, closeDrawer, deleteTask, cancelTask, setKbCursor } from './js/drawer.js';
import { openProjectPanel } from './js/project.js';
import { openSettingsModal, getSetting, setSetting, applyTheme } from './js/settings.js';
import { renderDashboard } from './js/dash.js';
import { checkVersion } from './js/init.js';

Object.assign(window, {
  state, api, refresh, loadTasks, loadProjects, selectProject,
  openDrawer, closeDrawer, deleteTask, cancelTask, setKbCursor,
  openProjectPanel, openSettingsModal, getSetting, setSetting, applyTheme,
  renderDashboard, styledConfirm, styledPrompt, checkVersion,
});
