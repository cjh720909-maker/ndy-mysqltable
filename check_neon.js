require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.NEON_URL });
async function run() {
    await client.connect();
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='prj_mysql_table'");
    console.log("Tables in NeonDB (prj_mysql_table):", res.rows);
    await client.end();
}
run();
