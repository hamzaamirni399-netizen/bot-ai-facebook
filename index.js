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

const systemPromptText = `You are ${config.botName}, a sophisticated AI assistant created and developed by **Hamza Amirni** (حمزة اعمرني).
- If someone asks who you are, say you are a smart assistant developed by Hamza Amirni.
- You respond fluently in: Moroccan Darija (الدارجة المغربية), Standard Arabic (العربية الفصحى), English, and French.
- Responsably, you are friendly, helpful, and professional.
- ALWAYS respond in the SAME language the user uses.
- Showcase Hamza's skills as a developer of bots and websites.`;

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

async function generateImage(prompt) {
    try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true&enhance=true`;
        return url;
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

    // 1. Automatic YouTube Link Detection
    const ytPattern = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/;
    if (ytPattern.test(text)) {
        callSendAPI(sender_psid, { text: "🔗 YouTube link detected! Getting it for you..." });
        const res = await savetube.download(text, '720');
        if (res.status) {
            return callSendAPI(sender_psid, { text: `✅ *${res.result.title}*\n\n🎬 Video Link:\n${res.result.download}\n\n*By Hamza Amirni*` });
        }
    }

    const args = text.split(' ');
    const command = args[0].toLowerCase();

    // 2. Commands
    if (['.menu', '.help', 'الاوامر', 'menu'].includes(command)) {
        const menu = `🌟 *${config.botName.toUpperCase()} PREMIUM MENU* 🌟\n\n` +
            `👨‍💻 *Developer:* ${config.ownerName}\n\n` +
            `�️ *AI IMAGE GENERATION:*\n` +
            `🎨 *.imagine [prompt]* : Create AI image\n\n` +
            `�️ *DOWNLOADER:*\n` +
            `✨ *.yts [name]* : Search YouTube\n` +
            `🎵 *.ytmp3 [url]* : YouTube Audio\n` +
            `🎬 *.ytmp4 [url]* : YouTube Video\n\n` +
            `� *RELIGION & CONTENT:*\n` +
            `🕌 *.quran [1-114]* : Quran Audio\n` +
            `📚 *.riwaya* : Random Short Story\n` +
            `🕋 *.adhkar* : Random Adhkar\n\n` +
            `� *SEARCH & UTILS:*\n` +
            `🌐 *.wiki [query]* : Wikipedia Info\n` +
            `🌍 *.tr [lang] [text]* : Translate\n` +
            `🌦️ *.weather [city]* : Current Weather\n\n` +
            `👤 *OWNER:* \n` +
            `👤 *.owner* : Social links\n` +
            `💻 *.services* : Hamza's Services\n\n` +
            `🛠️ *Developed for you by Hamza Amirni*`;
        return callSendAPI(sender_psid, { text: menu });
    }

    if (command === '.imagine') {
        const prompt = args.slice(1).join(' ');
        if (!prompt) return callSendAPI(sender_psid, { text: "Usage: .imagine [description]" });
        callSendAPI(sender_psid, { text: "🎨 Generating your artistic request..." });
        const imgUrl = await generateImage(prompt);
        if (imgUrl) {
            return callSendAPI(sender_psid, { text: `✅ *Result for:* ${prompt}\n\n🔗 View/Download:\n${imgUrl}` });
        } else { return callSendAPI(sender_psid, { text: "❌ Error generating image." }); }
    }

    if (command === '.wiki') {
        const query = args.slice(1).join(' ');
        if (!query) return callSendAPI(sender_psid, { text: "Usage: .wiki [search term]" });
        try {
            const { data } = await axios.get(`https://api.maher-zubair.tech/search/wikipedia?q=${encodeURIComponent(query)}`);
            if (data.status === 200) {
                return callSendAPI(sender_psid, { text: `🌐 *Wikipedia: ${query}*\n\n${data.result.content}` });
            }
        } catch (e) { return callSendAPI(sender_psid, { text: "No Wikipedia entry found." }); }
    }

    if (command === '.tr') {
        const lang = args[1];
        const toTranslate = args.slice(2).join(' ');
        if (!lang || !toTranslate) return callSendAPI(sender_psid, { text: "Usage: .tr [lang_code] [text]. Example: .tr ar Hello" });
        try {
            const { data } = await axios.get(`https://api.maher-zubair.tech/tools/translate?text=${encodeURIComponent(toTranslate)}&to=${lang}`);
            if (data.status === 200) {
                return callSendAPI(sender_psid, { text: `🌍 *Translation (${lang}):*\n\n${data.result}` });
            }
        } catch (e) { return callSendAPI(sender_psid, { text: "Translation failed." }); }
    }

    if (command === '.weather') {
        const city = args.slice(1).join(' ');
        if (!city) return callSendAPI(sender_psid, { text: "Usage: .weather [city]" });
        try {
            const { data } = await axios.get(`https://api.maher-zubair.tech/details/weather?q=${encodeURIComponent(city)}`);
            if (data.status === 200) {
                const w = data.result;
                return callSendAPI(sender_psid, { text: `🌦️ *Weather in ${city}:*\n\n🌡️ Temp: ${w.temperature}\n💧 Humidity: ${w.humidity}\n🌬️ Wind: ${w.wind}\n📝 Desc: ${w.description}` });
            }
        } catch (e) { return callSendAPI(sender_psid, { text: "City not found." }); }
    }

    if (command === '.adhkar') {
        try {
            const { data } = await axios.get("https://api.maher-zubair.tech/details/adhkar");
            if (data.status === 200) {
                return callSendAPI(sender_psid, { text: `🕋 *Adhkar:*\n\n${data.result.arabic}\n\n_Ref: ${data.result.reference}_` });
            }
        } catch (e) { return callSendAPI(sender_psid, { text: "Error getting Adhkar." }); }
    }

    if (command === '.riwaya') {
        const { data } = await axios.get("https://api.maher-zubair.tech/ai/chatgpt?q=tell me a very short interesting story in Arabic");
        return callSendAPI(sender_psid, { text: `📖 *Story:* \n\n${data.result || "Error"}` });
    }

    if (command === '.quran') {
        const surahNum = args[1];
        if (!surahNum || isNaN(surahNum) || surahNum < 1 || surahNum > 114) return callSendAPI(sender_psid, { text: "Usage: .quran [1-114]" });
        return callSendAPI(sender_psid, { text: `🕌 *Quran Surah ${surahNum}*\n\n🔗 Audio:\nhttps://cdn.islamic.network/quran/audio-surah/128/ar.alafasy/${surahNum}.mp3` });
    }

    if (command === '.owner') {
        return callSendAPI(sender_psid, { text: `� *DEVELOPER:* ${config.ownerName}\n\n📸 Instagram: ${config.social.instagram}\n📺 YouTube: ${config.social.youtube}\n💼 Portfolio: ${config.social.portfolio}\n💬 WhatsApp: ${config.social.whatsapp}` });
    }

    if (command === '.services') {
        return callSendAPI(sender_psid, { text: `💻 *HAMZA AMIRNI SERVICES:*\n\n` + config.services.map(s => `✔️ ${s}`).join('\n') + `\n\n📩 WhatsApp: ${config.social.whatsapp}` });
    }

    if (command === '.yts') {
        const query = args.slice(1).join(' ');
        if (!query) return callSendAPI(sender_psid, { text: "Usage: .yts [name]" });
        const { videos } = await yts(query);
        let res = `🎥 *YouTube Search:* ${query}\n\n`;
        videos.slice(0, 5).forEach((v, i) => res += `${i + 1}. *${v.title}*\n🔗 ${v.url}\n\n`);
        return callSendAPI(sender_psid, { text: res });
    }

    if (command === '.ytmp3' || command === '.ytmp4') {
        const url = args[1];
        if (!url) return callSendAPI(sender_psid, { text: `Usage: ${command} [url]` });
        const res = await savetube.download(url, command === '.ytmp3' ? 'mp3' : '720');
        if (res.status) {
            return callSendAPI(sender_psid, { text: `✅ *${res.result.title}*\n\n🔗 Link:\n${res.result.download}` });
        } else { return callSendAPI(sender_psid, { text: "❌ Failed." }); }
    }

    // 3. AI Fallback (Identifies as Hamza Amirni Bot)
    let aiReply = imageUrl ? await getGeminiResponse(sender_psid, text, imageUrl) : (await getLuminAIResponse(sender_psid, text) || await getHectormanuelAI(sender_psid, text));
    if (!aiReply) aiReply = imageUrl ? "Gemini Key Missing." : "Sorry, I can't reply right now.";

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

app.get('/health', (req, res) => res.status(200).send("OK"));
setInterval(() => {
    const url = config.publicUrl || (function () { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'server_url.json'))).url; } catch (e) { return null; } })();
    if (url) axios.get(url).catch(() => { });
}, 2 * 60 * 1000);

app.listen(process.env.PORT || 8080, () => console.log(chalk.cyan(`Bot starting...`)));
