const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// This line serves your index.html file to the browser
app.use(express.static(__dirname)); 

app.get('/api/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });

    try {
        // Create a unique session folder for this number
        const sessionDir = path.join(__dirname, 'sessions', number);
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // If they are already registered, don't give a new code
        if (state.creds.registered) {
            return res.json({ error: 'This number is already connected.' });
        }

        const sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        sock.ev.on('creds.update', saveCreds);

        // Request the pairing code
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(number);
                return res.json({ code: code });
            } catch (err) {
                console.log("WhatsApp Error:", err.message);
                return res.status(500).json({ error: 'Failed to generate code. IP might be blocked.' });
            }
        }, 2000);

    } catch (error) {
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(3000, () => console.log('Panel API running on port 3000'));