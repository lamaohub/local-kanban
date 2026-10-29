import { db } from '../db.js';
import { healthView } from '../health.js';

let flight = null; // a second request while the folders are walked waits for the same walk
export default async function healthRoutes(app) {
  app.get('/api/health', () => {
    if (!flight) {
      const projects = db.prepare('SELECT slug, name, path, category FROM projects WHERE archived = 0 ORDER BY position, name COLLATE NOCASE').all();
      flight = healthView(projects).finally(() => { flight = null; });
    }
    return flight;
  });
}
