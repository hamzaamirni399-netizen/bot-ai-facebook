const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const config = require('./config');
const chalk = require('chalk');
const yts = require('yt-search');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express().use(bodyParser.json());

// STRICT NAME FIX
const OWNER_NAME = "حمزة اعمرني";
config.ownerName = OWNER_NAME;

const systemPromptText = `You are ${config.botName}, a sophisticated AI assistant created and developed by **${OWNER_NAME}**.
- If someone asks who you are, say you are a smart assistant developed by the legendary developer ${OWNER_NAME}.
- ALWAYS refer to the owner as ${OWNER_NAME}.
- You respond fluently in: Moroccan Darija (الدارجة المغربية), Standard Arabic (العربية الفصحى), English, and French.
- Responsably, you are friendly, helpful, and professional.
- ALWAYS respond in the SAME language the user uses.
- For image requests, explain they should use .imagine [description].
- For *6 to *3, mention ${OWNER_NAME} provides VPN configs and they should use .owner to contact him.`;

// --- SAVETUBE LOGIC ---
const savetube = {
    api: { base: "https://media.savetube.me/api", cdn: "/random-cdn", info: "/v2/info", download: "/download" },
    headers: { 'accept': '*/*', 'content-type': 'application/json', 'origin': 'https://yt.savetube.me', 'referer': 'https://yt.savetube.me/', 'user-agent': 'Postify/1.0.0' },
    crypto: {
        hexToBuffer: (hexString) => Buffer.from(hexString.match(/.{1,2}/g).join(''), 'hex'),
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
                id: id, downloadType: format === 'mp3' ? 'audio' : 'video', quality: format === 'mp3' ? '128' : format, key: decrypted.key
            }, { headers: savetube.headers });
            return { status: true, result: { title: decrypted.title, download: dl.data.data.downloadUrl } };
        } catch (e) { return { status: false, error: e.message }; }
    }
};

// --- QURAN TEXT FETCHER ---
async function getQuranSurahText(surahNumber) {
    try {
        const { data } = await axios.get(`https://api.alquran.cloud/v1/surah/${surahNumber}`);
        if (data.code === 200 && data.data) {
            let verses = data.data.ayahs.map(a => `${a.text} (${a.numberInSurah})`).join(' ');
            return `📖 *سورة ${data.data.name}*\n\n${verses}\n\n*صدق الله العظيم*`;
        }
        return null;
    } catch (e) { return null; }
}

// --- AI FUNCTIONS ---
async function getLuminAIResponse(senderId, message) {
    try {
        const { data } = await axios.post("https://luminai.my.id/", { content: systemPromptText + "\n\nUser: " + message, user: senderId }, { timeout: 8000 });
        return data.result || null;
    } catch (e) { return null; }
}

async function getHectormanuelAI(senderId, message, model = "gpt-4o-mini") {
    try {
        const { data } = await axios.get(`https://all-in-1-ais.officialhectormanuel.workers.dev/?query=${encodeURIComponent(systemPromptText + "\n\nUser: " + message)}&model=${model}`, { timeout: 8000 });
        return data.success ? data.message?.content : null;
    } catch (e) { return null; }
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

// --- WEBHOOK LOGIC ---
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
    }

    console.log(chalk.blue(`[MSG] ${sender_psid}: ${text}`));
    sendTypingAction(sender_psid, 'typing_on');

    // 1. Automatic Link Detection
    const ytPattern = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/;
    if (ytPattern.test(text)) {
        callSendAPI(sender_psid, { text: "🔗 جاري تحضير التحميل من يوتيوب..." });
        const res = await savetube.download(text, '720');
        if (res.status) {
            // Try to send as attachment, fallback to link
            return sendAttachmentAPI(sender_psid, 'video', res.result.download, `✅ *${res.result.title}*\n\n*بواسطة ${OWNER_NAME}*`);
        }
    }

    const args = text.split(' ');
    const command = args[0].toLowerCase();

    // 2. Commands
    if (['.menu', '.help', 'الاوامر', 'menu', 'دليل'].includes(command)) {
        const menu = `🌟 *قائمة ${config.botName}* 🌟\n\n` +
            `👨‍💻 *المطور:* ${OWNER_NAME}\n\n` +
            `🎨 *.imagine [الوصف]* : إنشاء صورة فنية\n` +
            `✨ *.yts [الاسم]* : البحث في اليوتيوب\n` +
            `🎵 *.ytmp3 [الرابط]* : تحميل أوديو\n` +
            `🎬 *.ytmp4 [الرابط]* : تحميل فيديو\n` +
            `🕌 *.quran [1-114]* : قراءة السورة كاملة\n` +
            `📚 *.riwaya* : قصة قصيرة\n` +
            ` *.owner* : حسابات ${OWNER_NAME}\n\n` +
            `️ *Plugin by ${OWNER_NAME}*`;
        return callSendAPI(sender_psid, { text: menu });
    }

    if (command === '.imagine') {
        const prompt = args.slice(1).join(' ');
        if (!prompt) return callSendAPI(sender_psid, { text: "اكتب وصف الصورة!" });
        callSendAPI(sender_psid, { text: "🎨 جاري رسم الصورة..." });
        const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true&enhance=true`;
        return sendAttachmentAPI(sender_psid, 'image', imgUrl, `✅ النتيجة لـ: ${prompt}`);
    }

    if (command === '.quran' || command === 'قرآن') {
        const surah = args[1];
        if (!surah || isNaN(surah) || surah < 1 || surah > 114) return callSendAPI(sender_psid, { text: "مثال: .quran 1" });
        callSendAPI(sender_psid, { text: "📖 جاري جلب السورة..." });
        const quranText = await getQuranSurahText(surah);
        if (quranText) {
            // Split if too long for one message
            if (quranText.length > 2000) {
                const parts = quranText.match(/[\s\S]{1,1900}/g);
                for (let part of parts) await callSendAPI(sender_psid, { text: part });
                return;
            }
            return callSendAPI(sender_psid, { text: quranText });
        }
        return callSendAPI(sender_psid, { text: "فشل جلب السورة." });
    }

    if (command === '.ytmp4' || command === '.ytmp3') {
        const url = args[1];
        if (!url) return callSendAPI(sender_psid, { text: "حط الرابط!" });
        const type = command === '.ytmp3' ? 'audio' : 'video';
        callSendAPI(sender_psid, { text: "⏳ جاري المعالجة..." });
        const res = await savetube.download(url, type === 'audio' ? 'mp3' : '720');
        if (res.status) {
            return sendAttachmentAPI(sender_psid, type, res.result.download, `✅ *${res.result.title}*`);
        }
        return callSendAPI(sender_psid, { text: "فشل التحميل." });
    }

    if (command === '.owner') {
        return callSendAPI(sender_psid, { text: `👤 *المطور:* ${OWNER_NAME}\n\n📸 Instagram: ${config.social.instagram}\n WhatsApp: ${config.social.whatsapp}` });
    }

    // AI Fallback
    let aiReply = imageUrl ? await getGeminiResponse(sender_psid, text, imageUrl) : (await getLuminAIResponse(sender_psid, text) || await getHectormanuelAI(sender_psid, text));
    if (!aiReply) aiReply = "Sma7 lya, mafhamtch had l-message.";

    sendTypingAction(sender_psid, 'typing_off');
    callSendAPI(sender_psid, { text: aiReply });
}

function sendTypingAction(sender_psid, action) {
    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, { recipient: { id: sender_psid }, sender_action: action }).catch(() => { });
}

function callSendAPI(sender_psid, response) {
    return axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, { recipient: { id: sender_psid }, message: response })
        .catch(err => console.error(chalk.red('Error: ' + (err.response?.data?.error?.message || err.message))));
}

async function sendAttachmentAPI(sender_psid, type, url, caption) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, {
            recipient: { id: sender_psid },
            message: { attachment: { type: type === 'audio' ? 'audio' : (type === 'video' ? 'video' : 'image'), payload: { url, is_selectable: true } } }
        });
        if (caption) await callSendAPI(sender_psid, { text: caption });
    } catch (e) {
        // Fallback to sending just the link if attachment fails (FB limits)
        return callSendAPI(sender_psid, { text: `${caption}\n\n🔗 رابط مباشر:\n${url}` });
    }
}

app.get('/health', (req, res) => res.status(200).send("OK"));
setInterval(() => {
    const url = config.publicUrl || (function () { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'server_url.json'))).url; } catch (e) { return null; } })();
    if (url) axios.get(url).catch(() => { });
}, 2 * 60 * 1000);

app.listen(process.env.PORT || 8080, () => console.log(chalk.cyan(`Bot starting...`)));
