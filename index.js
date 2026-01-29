const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const config = require('./config');
const chalk = require('chalk');

const app = express().use(bodyParser.json());

const systemPromptText = `You are ${config.botName}, a sophisticated AI assistant created and developed by **Hamza Amirni** (حمزة اعمرني).
- You respond fluently in: Moroccan Darija (الدارجة المغربية), Standard Arabic (العربية الفصحى), English, and French.
- Responsably, you are friendly, helpful, and professional.
- ALWAYS respond in the SAME language the user uses.`;

// --- AI FUNCTIONS (Improved) ---

async function getHectormanuelAI(senderId, message, model = "gpt-4o") {
    try {
        const { data } = await axios.get(
            `https://all-in-1-ais.officialhectormanuel.workers.dev/?query=${encodeURIComponent(systemPromptText + "\n\nUser: " + message)}&model=${model}`,
            { timeout: 12000 }
        );
        if (data && data.success && data.message?.content) {
            return data.message.content;
        }
        return null;
    } catch (error) {
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

async function getAIDEVResponse(message) {
    try {
        const { data } = await axios.get(
            `https://api.maher-zubair.tech/ai/chatgpt?q=${encodeURIComponent(message)}`,
            { timeout: 12000 }
        );
        return data.result || null;
    } catch (error) {
        return null;
    }
}

async function getPollinationsResponse(message) {
    try {
        const { data } = await axios.post("https://text.pollinations.ai/openai", {
            messages: [{ role: "system", content: systemPromptText }, { role: "user", content: message }],
            model: "openai",
            seed: Math.floor(Math.random() * 1000000),
        }, { timeout: 15000 });
        return data.choices?.[0]?.message?.content || (typeof data === "string" ? data : null);
    } catch (error) {
        return null;
    }
}

// --- FACEBOOK MESSENGER LOGIC ---

app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
            console.log(chalk.green('WEBHOOK_VERIFIED'));
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post('/webhook', (req, res) => {
    let body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(function (entry) {
            if (!entry.messaging) return;
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;
            if (webhook_event.message && webhook_event.message.text) {
                handleMessage(sender_psid, webhook_event.message);
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

async function handleMessage(sender_psid, received_message) {
    const text = received_message.text;
    console.log(chalk.blue(`[FB-BOT] Message from ${sender_psid}: ${text}`));

    // Try AI models in sequence
    let aiReply = await getHectormanuelAI(sender_psid, text, "gpt-4o")
        || await getHectormanuelAI(sender_psid, text, "gpt-4o-mini")
        || await getLuminAIResponse(sender_psid, text)
        || await getAIDEVResponse(text)
        || await getPollinationsResponse(text);

    if (!aiReply) {
        aiReply = "Afwan, ma9dertch njawb 3la had l-message f had l-we9t. Jaraib mara okhra!";
    }

    callSendAPI(sender_psid, { "text": aiReply });
}

function callSendAPI(sender_psid, response) {
    let request_body = {
        "recipient": { "id": sender_psid },
        "message": response
    };

    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`, request_body)
        .then(() => {
            console.log(chalk.green('Message sent successfully!'));
        })
        .catch(err => {
            console.error(chalk.red('Unable to send message: ' + (err.response?.data?.error?.message || err.message)));
        });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(chalk.cyan(`Facebook Bot Webhook is listening on port ${PORT}`)));
