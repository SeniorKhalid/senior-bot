'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const MODE_FILE = path.join(__dirname, 'mode.json');
const PREFIX = '.';

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

let mode = fs.existsSync(MODE_FILE) ? fs.readFileSync(MODE_FILE, 'utf8').trim() : 'public';

// Keep track of all active bot connections
const activeBots = new Map();

async function startBotForSession(sessionFolder) {
    const sessionPath = path.join(SESSIONS_DIR, sessionFolder);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // If the session isn't registered, skip it
    if (!state.creds.registered) return;

    const version = [2, 3000, 1015901307];

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        version: version,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`Reconnecting session: ${sessionFolder}`);
                startBotForSession(sessionFolder);
            } else {
                console.log(`Logged out session: ${sessionFolder}`);
                activeBots.delete(sessionFolder);
            }
        } else if (connection === 'open') {
            console.log(`✅ Bot connected for number: ${sessionFolder}`);
            activeBots.set(sessionFolder, sock);
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const msg = chatUpdate.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const mtype = Object.keys(msg.message)[0];
            const text = (mtype === 'conversation') ? msg.message.conversation : 
                         (mtype === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : "";
            
            const from = msg.key.remoteJid;
            const sender = msg.key.participant || msg.key.remoteJid;

            const botNumber = sock.user.id.split(':')[0];
            const senderNumber = sender.split('@')[0].split(':')[0];
            const isSelf = botNumber === senderNumber;

            if (mode === 'private' && !isSelf) return;
            if (!text.startsWith(PREFIX)) return;
            
            const args = text.slice(PREFIX.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            // --- COMMANDS ---
            if (command === 'menu') {
                const menu = `👑 *SENIOR BOT MENU* 👑\n\nPrefix: [ . ] | Mode: [ ${mode} ]\n\n🔹 .menu\n🔹 .vv\n🔹 .play\n🔹 .kick\n🔹 .add\n\n*Owner:*\n🔹 .private / .public`;
                await sock.sendMessage(from, { text: menu }, { quoted: msg });
            }

            if (command === 'private' || command === 'public') {
                if (!isSelf) return;
                mode = command;
                fs.writeFileSync(MODE_FILE, mode);
                await sock.sendMessage(from, { text: `✅ Mode: *${mode.toUpperCase()}*` }, { quoted: msg });
            }

            if (command === 'vv') {
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) return sock.sendMessage(from, { text: "❌ Reply to a View Once message." });
                const viewOnce = quotedMsg.viewOnceMessageV2 || quotedMsg.viewOnceMessage;
                if (viewOnce) {
                    try {
                        const buffer = await downloadMediaMessage({ key: msg.key, message: viewOnce.message }, 'buffer', {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
                        const mediaType = Object.keys(viewOnce.message)[0];
                        if (mediaType === 'imageMessage') await sock.sendMessage(from, { image: buffer, caption: "✅ Captured" }, { quoted: msg });
                        else if (mediaType === 'videoMessage') await sock.sendMessage(from, { video: buffer, caption: "✅ Captured" }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(from, { text: "❌ Failed to download." }); }
                }
            }

            if (command === 'kick') {
                if (!from.endsWith('@g.us')) return;
                const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                if (!quotedParticipant) return sock.sendMessage(from, { text: "❌ Reply to the person you want to kick." });
                try {
                    const metadata = await sock.groupMetadata(from);
                    const participant = metadata.participants.find(p => p.id === sender);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
                    if (!isAdmin && !isSelf) return sock.sendMessage(from, { text: "❌ You must be an admin." });
                    await sock.groupParticipantsUpdate(from, [quotedParticipant], "remove");
                    await sock.sendMessage(from, { text: "✅ User kicked." });
                } catch (err) { await sock.sendMessage(from, { text: "❌ Failed." }); }
            }

            if (command === 'add') {
                if (!from.endsWith('@g.us')) return;
                const num = args[0];
                if (!num) return sock.sendMessage(from, { text: "❌ Provide a number." });
                try {
                    const metadata = await sock.groupMetadata(from);
                    const participant = metadata.participants.find(p => p.id === sender);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
                    if (!isAdmin && !isSelf) return sock.sendMessage(from, { text: "❌ You must be an admin." });
                    const jid = num.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    await sock.groupParticipantsUpdate(from, [jid], "add");
                    await sock.sendMessage(from, { text: `✅ Added ${num}` });
                } catch (err) { await sock.sendMessage(from, { text: "❌ Failed." }); }
            }

            if (command === 'play') {
                const query = args.join(' ');
                if (!query) return sock.sendMessage(from, { text: "❌ Provide a song or YouTube link." });
                await sock.sendMessage(from, { text: "⏳ Downloading..." }, { quoted: msg });
                try {
                    const apiRes = await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(query)}`);
                    const audioUrl = apiRes.data.url;
                    if (!audioUrl) throw new Error("No audio.");
                    await sock.sendMessage(from, { audio: { url: audioUrl }, mimetype: 'audio/mp4', fileName: `${apiRes.data.title}.mp3` }, { quoted: msg });
                } catch (e) { await sock.sendMessage(from, { text: "❌ Failed." }, { quoted: msg }); }
            }

        } catch (err) { console.error("Message Error:", err); }
    });
}

// Startup: Load all paired sessions
async function startAll() {
    console.log("Starting Senior Bot Panel Engine...");
    if (fs.existsSync(SESSIONS_DIR)) {
        const folders = fs.readdirSync(SESSIONS_DIR);
        for (const folder of folders) {
            if (fs.statSync(path.join(SESSIONS_DIR, folder)).isDirectory()) {
                await startBotForSession(folder);
            }
        }
    }
}

startAll();