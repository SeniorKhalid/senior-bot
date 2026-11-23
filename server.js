const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// Keep track of active sockets so they don't close prematurely
const activeSockets = new Map();

app.get('/api/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });

    try {
        const sessionDir = path.join(__dirname, 'sessions', number);
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        if (state.creds.registered) {
            return res.json({ error: 'This number is already connected.' });
        }

        const sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        // Store the socket in memory so it doesn't get garbage collected
        activeSockets.set(number, sock);
        sock.ev.on('creds.update', saveCreds);

        // Listen for connection updates to keep the socket alive
        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(`✅ Successfully linked ${number}!`);
                activeSockets.delete(number);
            }
            if (connection === 'close') {
                console.log(`Connection closed for ${number}.`);
                activeSockets.delete(number);
            }
        });

        // Request the pairing code
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(number);
                return res.json({ code: code });
            } catch (err) {
                console.log("WhatsApp Error:", err.message);
                return res.status(500).json({ error: 'Failed to generate code.' });
            }
        }, 2000);

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/reset', (req, res) => {
    const number = req.query.number;
    if (!number) return res.send("Provide a number");
    
    const sessionDir = path.join(__dirname, 'sessions', number);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        return res.send(`✅ Session for ${number} deleted!`);
    }
    return res.send(`❌ No session found for ${number}`);
});

app.listen(3000, () => console.log('Panel API running on port 3000'));

// Keep-alive for Render
setInterval(() => {
    https.get('https://senior-bot-0aka.onrender.com', (res) => {
        console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => console.log("Keep-alive error"));
}, 5 * 60 * 1000);
