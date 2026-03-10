require('dotenv').config();
const { Client } = require('pg');

const client = new Client({ connectionString: process.env.NEON_URL });

async function run() {
    try {
        await client.connect();
        const res = await client.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    `);
        console.log("All user tables in NeonDB:");
        console.table(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        await client.end();
    }
}
run();
