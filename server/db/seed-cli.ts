/** `npm run seed` — idempotently inserts synthetic demo records into the configured database. */
import { loadDotEnv, readConfig } from '../config';
import { DisabledProvider } from '../services/ai/providers';
import { CareRouteService } from '../services/careroute-service';
import { Database } from './database';
import { seedDemoData } from './seed';

loadDotEnv();
const config = readConfig();
const db = new Database(config.dbPath);
const service = new CareRouteService(db, { aiProvider: new DisabledProvider(), aiTimeoutMs: 1000, emergencyInstruction: config.emergencyInstruction });
const created = await seedDemoData(service);
const total = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM appointment_requests')?.c ?? 0;
console.log(`Seeded ${created} new synthetic record(s); ${total} request(s) in ${config.dbPath}.`);
db.close();
