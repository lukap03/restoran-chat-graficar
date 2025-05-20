const fs = require("fs");
const path = require("path");
const express = require('express');
require('dotenv').config();
const rateLimit = require('express-rate-limit');

const TRAINING_DATA_PATH = path.join(__dirname, "restaurant-info.txt");
const LOG_PATH = path.join(__dirname, "chat-log.json");

const rezervacijaLink = "https://w.eventlin.com/Restoran-Graficar?merchant=23853";

let trainingData = "";
try {
  trainingData = fs.readFileSync(TRAINING_DATA_PATH, "utf8");
  console.log("📚 Učitani podaci iz TXT fajla");
} catch (err) {
  console.error("❌ Greška pri učitavanju .txt fajla:", err);
}

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public')); // Služi statičke fajlove (index.html, itd.)

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: "Previše zahteva. Pokušaj ponovo za minut."
  }
});
app.use('/api/chat', limiter);

// === Pomoćne funkcije ===

function isReservationQuestion(userMessage) {
  const reservationKeywords = [
    "rezervacija", "rezervisem", "rezervisati", "sto",
    "rezervisati sto", "mogu li da rezervišem"
  ];
  const lowerCaseMessage = userMessage.toLowerCase();
  return reservationKeywords.some(keyword => lowerCaseMessage.includes(keyword));
}

function formatResponse(text) {
  const paragraphs = text.split('\n').map(line => line.trim()).filter(line => line !== '');

  const formatted = paragraphs.map(paragraph => {
    // Ako već sadrži HTML tag (npr. link koji si ubacio ručno), nemoj ništa dirati
    if (paragraph.includes('<a')) {
      return `<p>${paragraph}</p>`;
    }

    const withPhoneLinks = paragraph.replace(
      /(\+?\d[\d\s\-\/]{7,}\d)/g,
      '<a href="tel:$1" style="text-decoration: underline;">$1</a>'
    );
    const withLinks = withPhoneLinks.replace(
      /(https?:\/\/[^\s]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return `<p>${withLinks}</p>`;
  });

  return formatted.join('');
}



// === API Chat ruta ===

app.post('/api/chat', async (req, res) => {
  const { userMessage } = req.body;

  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ success: false, error: "Nevalidna poruka. Mora biti tekstualna vrednost." });
  }

  const trimmedMessage = userMessage.trim();

  if (trimmedMessage.length === 0) {
    return res.status(400).json({ success: false, error: "Poruka ne može biti prazna." });
  }

  if (trimmedMessage.length > 500) {
    return res.status(400).json({ success: false, error: "Poruka je predugačka. Maksimum je 500 karaktera." });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("⛔ OPENAI_API_KEY nije definisan!");
    return res.status(500).json({ error: "API ključ nije postavljen." });
  }

  try {
    // === Detekcija jezika ===
    function isRussianText(text) {
  const russianChars = /[ЁёЫыЭэЪъЖжШшЩщЮюЯяЙй]/;
  return russianChars.test(text);
}

let languageCode = "sr"; // podrazumevano

if (isRussianText(userMessage)) {
  languageCode = "ru";
} else {
  // Ako nije jasno, koristi OpenAI za preciznu detekciju
  const detectLangRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4-turbo",
      messages: [{
        role: "user",
        content: `Detektuj jezik ovog teksta i odgovori isključivo dvoslovnim ISO 639-1 kodom bez dodatnih objašnjenja. Tekst: "${userMessage}"`
      }]
    })
  });

  const detectData = await detectLangRes.json();
  languageCode = detectData?.choices?.[0]?.message?.content?.trim().toLowerCase() || "sr";
}


    // === Generisanje odgovora ===
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `
              Ti si ljubazan, strpljiv i profesionalan konobar restorana Grafičar iz Beograda.
              Odgovaraj na jeziku korisnika (jezik poruke: ${languageCode}).
              Ako korisnik koristi neki strani jezik, ti se prilagodi i piši na tom jeziku.
              ${trainingData}.
              Kada te pita za meni, posalji sve kategorije i pitaj sta ga konkretno zanima.
              Reč pozdrav napiši samo na početku konverzacije.
              Ako gost želi da naruči, reci mu da je jedina opcija za naručivanje pitem konobara u restoranu.
            `
          },
          {
            role: "user",
            content: trimmedMessage
          }
        ]
      })
    });

    const data = await openaiRes.json();
    console.log("🔍 OpenAI odgovor:", data);

    if (openaiRes.status !== 200) {
      return res.status(500).json({ error: "Greška iz OpenAI API-ja", details: data });
    }

    let rawReply = data?.choices?.[0]?.message?.content || "Bot nije odgovorio.";

    if (isReservationQuestion(userMessage)) {
  rawReply += `\n\nZa više informacija i da izvršite rezervaciju, kliknite <a href="${rezervacijaLink}" target="_blank" rel="noopener noreferrer">ovde</a>.`;
}


    const reply = formatResponse(rawReply);

    const logEntry = {
      timestamp: new Date().toISOString(),
      question: userMessage,
      answer: reply
    };

    fs.readFile(LOG_PATH, "utf8", (err, fileData) => {
      let logs = [];
      if (!err && fileData) {
        try {
          logs = JSON.parse(fileData);
        } catch (e) {
          console.error("Greška pri parsiranju loga:", e);
        }
      }
      logs.push(logEntry);
      fs.writeFile(LOG_PATH, JSON.stringify(logs, null, 2), (err) => {
        if (err) console.error("Greška pri upisu loga:", err);
      });
    });

    res.json({ choices: [{ message: { content: reply } }] });

  } catch (err) {
    console.error("❌ Došlo je do greške:", err);
    res.status(500).json({ error: "Došlo je do greške pri komunikaciji sa OpenAI-jem." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server radi na http://localhost:${PORT}`);
});
