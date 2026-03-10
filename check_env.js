require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const tables = Object.keys(prisma).filter(key => !key.startsWith('_') && !key.startsWith('$'));
console.log("COMMENT_DATABASE_URL:", process.env.COMMENT_DATABASE_URL);
console.log("Number of models in prisma:", tables.length);
console.log("First 10 models:", tables.slice(0, 10));
