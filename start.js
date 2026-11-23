const { spawn } = require('child_process');

// Start the web panel (server.js)
const server = spawn('node', ['server.js'], { stdio: 'inherit' });
// Start the bot engine (index.js)
const bot = spawn('node', ['index.js'], { stdio: 'inherit' });

server.on('close', (code) => console.log(`Server exited with code ${code}`));
bot.on('close', (code) => console.log(`Bot exited with code ${code}`));