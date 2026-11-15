// Aufräumen nach jedem Lauf (von run.sh per trap aufgerufen): Prozesse, Datenbanken, Docker-Ressourcen.
import { cleanup as dockerCleanup } from './docker.mjs';
import { dropAllE2eDatabases } from './control.mjs';
import { readState, updateState } from './util.mjs';

for (const pid of readState().pids) {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* weg */ } }
  }
}
const dbs = await dropAllE2eDatabases().catch((e) => `DB-Aufräumen: ${e.message}`);
const dk = await dockerCleanup().catch((e) => ({ fehler: e.message }));
updateState((s) => { s.pids = []; s.dbs = []; });
console.log(`Aufgeräumt: Docker ${JSON.stringify(dk)}, Datenbanken ${Array.isArray(dbs) ? dbs.length : dbs}`);
