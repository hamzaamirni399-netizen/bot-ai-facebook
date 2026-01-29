const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const config = require('./config');
const chalk = require('chalk');
const yts = require('yt-search');
const fs = require('fs-extra');
const path = require('path');

const app = express().use(bodyParser.json());

const systemPromptText = `You are ${config.botName}, a sophisticated AI assistant created and developed by **Hamza Amirni** (حمزة اعمرني).
- You respond fluently in: Moroccan Darija (الدارجة المغربية), Standard Arabic (العربية الفصحى), English, and French.
- Responsably, you are friendly, helpful, and professional.
- ALWAYS respond in the SAME language the user uses.
- Image Analysis: You can "see" and "read" photos perfectly and describe them or solve problems in them.`;

// --- AI FUNCTIONS ---

async function getHectormanuelAI(senderId, message, model = "gpt-4o") {
    try {
        const { data } = await axios.get(
            `https://all-in-1-ais.officialhectormanuel.workers.dev/?query=${encodeURIComponent(systemPromptText + "\n\nUser: " + message)}&model=${model}`,
            { timeout: 15000 }
        );
        if (data && data.success && data.message?.content) {
            return data.message.content;
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function getGeminiResponse(senderId, text, imageUrl = null) {
    if (!config.geminiApiKey) return null;
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${config.geminiApiKey}`;
        const contents = [{
            parts: [{ text: systemPromptText + "\n\nUser: " + text }]
        }];

        if (imageUrl) {
            const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            contents[0].parts.push({
                inline_data: {
                    mime_type: "image/jpeg",
                    data: Buffer.from(imageRes.data).toString("base64")
                }
            });
        }

        const res = await axios.post(url, { contents }, { timeout: 20000 });
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) {
        return null;
    }
}

async function getLuminAIResponse(senderId, message) {
    try {
        const { data } = await axios.post("https://luminai.my.id/", {
            content: systemPromptText + "\n\nUser: " + message,
            user: senderId,
        }, { timeout: 12000 });
        return data.result || null;
    } catch (error) {
        return null;
    }
}

// --- KEEP-ALIVE SYSTEM ---

app.get('/', (req, res) => {
    // Auto-detect Public URL
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host;
    if (host && !host.includes("127.0.0.1") && !host.includes("localhost")) {
        const detectedUrl = `${protocol}://${host}`;
        if (!config.publicUrl || config.publicUrl.includes("example.com")) {
            config.publicUrl = detectedUrl;
            try {
                fs.writeFileSync(path.join(__dirname, 'server_url.json'), JSON.stringify({ url: detectedUrl }));
            } catch (e) { }
        }
    }
    res.json({ status: "running", bot: config.botName, url: config.publicUrl });
});

app.get('/health', (req, res) => res.status(200).send("OK"));

// Self-ping interval (Every 2 minutes)
setInterval(() => {
    const url = config.publicUrl || (function () {
        try {
            return JSON.parse(fs.readFileSync(path.join(__dirname, 'server_url.json'))).url;
        } catch (e) { return null; }
    })();

    if (url) {
        axios.get(url).catch(() => { });
        console.log(chalk.gray(`[KEEP-ALIVE] Pinged ${url}`));
    }
}, 2 * 60 * 1000);

// --- FACEBOOK MESSENGER LOGIC ---

app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];
    if (mode && token === config.VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    let body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(entry => {
            if (!entry.messaging) return;
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;

            if (webhook_event.message) {
                handleMessage(sender_psid, webhook_event.message);
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

async function handleMessage(sender_psid, received_message) {
    let text = received_message.text || "";
    let imageUrl = null;

    // Check for images
    if (received_message.attachments && received_message.attachments[0].type === 'image') {
        imageUrl = received_message.attachments[0].payload.url;
        if (!text) text = "Describe this image";
    }

    console.log(chalk.blue(`[FB-BOT] Message from ${sender_psid}: ${text}`));

    // 1. Check for YouTube search command
    if (text.toLowerCase().startsWith(".yts") || text.toLowerCase().startsWith("يتس")) {
        const query = text.split(" ").slice(1).join(" ");
        if (!query) return callSendAPI(sender_psid, { text: "Goulli chnou n9elleb 3lih f YouTube? Mital: .yts song name" });

        try {
            const search = await yts(query);
            const videos = search.videos.slice(0, 5);
            let resultText = `🎥 *YouTube Search Results for:* ${query}\n\n`;
            videos.forEach((v, i) => {
                resultText += `${i + 1}. *${v.title}*\n🔗 ${v.url}\n⏱️ ${v.timestamp} | 📅 ${v.ago}\n\n`;
            });
            return callSendAPI(sender_psid, { text: resultText });
        } catch (e) {
            return callSendAPI(sender_psid, { text: "Sma7 lya, wa9e3 mochkil f l-ba7t dyal YouTube." });
        }
    }

    // 2. AI Response (with Vision if image exists)
    let aiReply = null;

    if (imageUrl) {
        // Use Gemini for Image Analysis
        aiReply = await getGeminiResponse(sender_psid, text, imageUrl);
        if (!aiReply) aiReply = "Sma7 lya, ma9dertch n9ra had l-tswira. Jereb mrra okhra!";
    } else {
        // Standard Text AI
        aiReply = await getHectormanuelAI(sender_psid, text) || await getLuminAIResponse(sender_psid, text);
    }

    if (!aiReply) aiReply = "Afwan, ma9dertch njawb 3la had l-message f had l-we9t.";

    callSendAPI(sender_psid, { text: aiReply });
}

function callSendAPI(sender_psid, response) {
    let request_body = {
        "recipient": { "id": sender_psid },
        "message": response
    };

    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, request_body)
        .then(() => console.log(chalk.green('Message sent successfully!')))
        .catch(err => console.error(chalk.red('Unable to send message: ' + (err.response?.data?.error?.message || err.message))));
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(chalk.cyan(`Facebook Bot Webhook is listening on port ${PORT}`)));
