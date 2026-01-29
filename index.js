const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const config = require('./config');
const chalk = require('chalk');
const yts = require('yt-search');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');

const app = express().use(bodyParser.json());

const systemPromptText = `You are ${config.botName}, a sophisticated AI assistant created and developed by **Hamza Amirni** (حمزة اعمرني).
- You respond fluently in: Moroccan Darija (الدارجة المغربية), Standard Arabic (العربية الفصحى), English, and French.
- Responsably, you are friendly, helpful, and professional.
- ALWAYS respond in the SAME language the user uses.
- Image Analysis: You can "see" and "read" photos perfectly.`;

// --- SAVETUBE LOGIC (by Hamza Amirni) ---

const savetube = {
    api: {
        base: "https://media.savetube.me/api",
        cdn: "/random-cdn",
        info: "/v2/info",
        download: "/download"
    },
    headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://yt.savetube.me',
        'referer': 'https://yt.savetube.me/',
        'user-agent': 'Postify/1.0.0'
    },
    formats: ['144', '240', '360', '480', '720', '1080', 'mp3'],
    crypto: {
        hexToBuffer: (hexString) => {
            const matches = hexString.match(/.{1,2}/g);
            return Buffer.from(matches.join(''), 'hex');
        },
        decrypt: async (enc) => {
            const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
            const data = Buffer.from(enc, 'base64');
            const iv = data.slice(0, 16);
            const content = data.slice(16);
            const key = savetube.crypto.hexToBuffer(secretKey);
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            let decrypted = decipher.update(content);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            return JSON.parse(decrypted.toString());
        }
    },
    download: async (link, format) => {
        try {
            const idMatch = link.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/);
            const id = idMatch ? idMatch[1] : null;
            if (!id) throw new Error("Invalid YouTube link");

            const cdnRes = await axios.get(`${savetube.api.base}${savetube.api.cdn}`, { headers: savetube.headers });
            const cdn = cdnRes.data.cdn;

            const infoRes = await axios.post(`https://${cdn}${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers });
            const decrypted = await savetube.crypto.decrypt(infoRes.data.data);

            const dl = await axios.post(`https://${cdn}${savetube.api.download}`, {
                id: id,
                downloadType: format === 'mp3' ? 'audio' : 'video',
                quality: format === 'mp3' ? '128' : format,
                key: decrypted.key
            }, { headers: savetube.headers });

            return { status: true, result: { title: decrypted.title, download: dl.data.data.downloadUrl, type: format === 'mp3' ? 'audio' : 'video' } };
        } catch (e) {
            return { status: false, error: e.message };
        }
    }
};

// --- AI FUNCTIONS ---

async function getLuminAIResponse(senderId, message) {
    try {
        const { data } = await axios.post("https://luminai.my.id/", {
            content: systemPromptText + "\n\nUser: " + message,
            user: senderId,
        }, { timeout: 8000 });
        return data.result || null;
    } catch (error) { return null; }
}

async function getHectormanuelAI(senderId, message, model = "gpt-4o-mini") {
    try {
        const { data } = await axios.get(
            `https://all-in-1-ais.officialhectormanuel.workers.dev/?query=${encodeURIComponent(systemPromptText + "\n\nUser: " + message)}&model=${model}`,
            { timeout: 8000 }
        );
        return data.success ? data.message?.content : null;
    } catch (error) { return null; }
}

async function getGeminiResponse(senderId, text, imageUrl = null) {
    if (!config.geminiApiKey) return null;
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${config.geminiApiKey}`;
        const contents = [{ parts: [{ text: systemPromptText + "\n\nUser: " + text }] }];
        if (imageUrl) {
            const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            contents[0].parts.push({ inline_data: { mime_type: "image/jpeg", data: Buffer.from(imageRes.data).toString("base64") } });
        }
        const res = await axios.post(url, { contents }, { timeout: 15000 });
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) { return null; }
}

// --- KEEP-ALIVE SYSTEM ---

app.get('/', (req, res) => {
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host;
    if (host && !host.includes("127.0.0.1") && !host.includes("localhost")) {
        const detectedUrl = `${protocol}://${host}`;
        if (!config.publicUrl || config.publicUrl.includes("example.com")) {
            config.publicUrl = detectedUrl;
            try { fs.writeFileSync(path.join(__dirname, 'server_url.json'), JSON.stringify({ url: detectedUrl })); } catch (e) { }
        }
    }
    res.json({ status: "running", bot: config.botName, url: config.publicUrl });
});

setInterval(() => {
    const url = config.publicUrl || (function () {
        try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'server_url.json'))).url; } catch (e) { return null; }
    })();
    if (url) axios.get(url).catch(() => { });
}, 2 * 60 * 1000);

// --- FACEBOOK MESSENGER LOGIC ---

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

app.post('/webhook', (req, res) => {
    if (req.body.object === 'page') {
        req.body.entry.forEach(entry => {
            if (entry.messaging) handleMessage(entry.messaging[0].sender.id, entry.messaging[0].message);
        });
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

async function handleMessage(sender_psid, received_message) {
    if (!received_message || (!received_message.text && !received_message.attachments)) return;

    let text = received_message.text || "";
    let imageUrl = null;
    if (received_message.attachments && received_message.attachments[0].type === 'image') {
        imageUrl = received_message.attachments[0].payload.url;
        if (!text) text = "Analyze this";
    }

    console.log(chalk.blue(`[MSG] ${sender_psid}: ${text}`));
    sendTypingAction(sender_psid, 'typing_on');

    const args = text.split(' ');
    const command = args[0].toLowerCase();

    // --- COMMANDS ---

    if (command === '.menu' || command === '.help' || command === 'الاوامر') {
        const menuText = `🌟 *${config.botName} MENU* 🌟\n\n` +
            `🤖 *AI & Vision:*\n` +
            `- Just send a message or an image to talk with me!\n\n` +
            `📽️ *YouTube Downloader:*\n` +
            `- *.ytmp3 [url]* : Download Audio\n` +
            `- *.ytmp4 [url]* : Download Video\n` +
            `- *.yts [name]* : Search YouTube\n\n` +
            `⚡ *Plugin by Hamza Amirni*`;
        return callSendAPI(sender_psid, { text: menuText });
    }

    if (command === '.yts') {
        const query = args.slice(1).join(' ');
        if (!query) return callSendAPI(sender_psid, { text: "Usage: .yts [video name]" });
        try {
            const { videos } = await yts(query);
            let res = `🎥 *Search:* ${query}\n\n`;
            videos.slice(0, 5).forEach((v, i) => res += `${i + 1}. *${v.title}*\n🔗 ${v.url}\n\n`);
            return callSendAPI(sender_psid, { text: res });
        } catch (e) { return callSendAPI(sender_psid, { text: "Error searching YouTube." }); }
    }

    if (command === '.ytmp3' || command === '.ytmp4') {
        const url = args[1];
        if (!url) return callSendAPI(sender_psid, { text: `Usage: ${command} [url]` });
        const format = command === '.ytmp3' ? 'mp3' : '720';
        try {
            callSendAPI(sender_psid, { text: "⏳ Processing your request..." });
            const res = await savetube.download(url, format);
            if (res.status) {
                return callSendAPI(sender_psid, { text: `✅ *${res.result.title}*\n\n🔗 Download Link:\n${res.result.download}` });
            } else { return callSendAPI(sender_psid, { text: "❌ Failed: " + res.error }); }
        } catch (e) { return callSendAPI(sender_psid, { text: "Error downloading video." }); }
    }

    // --- AI FALLBACK ---
    let aiReply = imageUrl ? await getGeminiResponse(sender_psid, text, imageUrl) : (await getLuminAIResponse(sender_psid, text) || await getHectormanuelAI(sender_psid, text));
    if (!aiReply) aiReply = imageUrl ? "Sma7 lya, Gemini API key is missing for images." : "Afwan, ma9dertch njawb f had l-we9t.";

    sendTypingAction(sender_psid, 'typing_off');
    callSendAPI(sender_psid, { text: aiReply });
}

function sendTypingAction(sender_psid, action) {
    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, { recipient: { id: sender_psid }, sender_action: action }).catch(() => { });
}

function callSendAPI(sender_psid, response) {
    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, { recipient: { id: sender_psid }, message: response })
        .catch(err => console.error(chalk.red('Error: ' + (err.response?.data?.error?.message || err.message))));
}

app.listen(process.env.PORT || 8080, () => console.log(chalk.cyan(`Bot starting...`)));
