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
app.use(express.static('public')); 
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: "Previše zahteva. Pokušaj ponovo za minut."
  }
});
app.use('/api/chat', limiter);
function isReservationQuestion(userMessage) {
  const reservationKeywords = [
    // SR/HR/BS
  'rezerv', 'rezervacij', 'rezervis', 'sto ', 'stolik', 'sto za',
  // EN
  'reservation', 'reserve', 'booking', 'book a table', 'table for',
  // DE
  'reservierung', 'reservier', 'tisch reserv', 'tisch fur', 'tisch für',
  // FR
  'réserv', 'reserver', 'reservation', 'table pour',
  // ES
  'reserva', 'reservar', 'mesa para',
  // IT
  'prenotaz', 'prenotare', 'tavolo per',
  // RU (ćirilica)
  'бронь', 'забронировать', 'резервац', 'столик', 'стол ',
  // TR (dodaj i ASCII varijantu)
  'rezervasyon', 'masa ayırt', 'masa ayirt', 'masa rezerve',
  // EL (grčki)
  'κρατηση', 'κρατησω', 'τραπεζι', 'τραπέζι',
  // ZH (kineski – pojednostavljeni i tradicionalni)
  '预订',        // yùdìng (rezervacija)
  '预定',        // yùdìng (varijanta)
  '订位',        // dìngwèi (rezervacija sedišta/stola)
  '订桌',        // dìngzhuō (rezervacija stola)
  '訂位',        // traditional
  '訂桌',        // traditional
  '預訂',        // traditional
  '預定'         // traditional
  ];
  const lowerCaseMessage = userMessage.toLowerCase();
  return reservationKeywords.some(keyword => lowerCaseMessage.includes(keyword));
}
function formatResponse(text) {
  const paragraphs = text.split('\n').map(line => line.trim()).filter(line => line !== '');

  const formatted = paragraphs.map(paragraph => {
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
    function isClearlyRussian(text) {
      const cyrillicPattern = /[а-яё]/i;
      const russianWords = [
        "меня", "интересуют", "салаты", "привет", "пожалуйста", "спасибо",
        "блюдо", "вкусно", "заказ", "здравствуйте", "официант", "где", "жду",
        "чек", "адрес", "ресторан", "столик", "меню", "вино", "пиво", "суп"
      ];

      const hasCyrillic = cyrillicPattern.test(text);
      const hasRussianWord = russianWords.some(word => text.toLowerCase().includes(word));

      return hasCyrillic && hasRussianWord;
    }

    let languageCode = "sr"; 

    if (isClearlyRussian(trimmedMessage)) {
      languageCode = "ru";
    } else {
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
            content: `
              Odredi ISO 639-1 dvoslovni kod jezika sledećeg teksta.

              Odgovori isključivo jednim dvoslovnim kodom bez dodatnih objašnjenja.

              VAŽNO:
              Ako tekst sadrži reči kao što su: "меня", "интересуют", "салаты", "привет", "пожалуйста", "спасибо", "блюдо", "вкусно", "заказ", "здравствуйте", "официант", "где", "жду", "чек", "адрес", smatraj da je to ruski jezik i **nikad nemoj vratiti 'sr'** u tim slučajevima.

              Tekst: "${trimmedMessage}"
                  `.trim()
          }]
        })
      });
      const detectData = await detectLangRes.json();
      languageCode = detectData?.choices?.[0]?.message?.content?.trim().toLowerCase() || "sr";
    }
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

              Odgovaraj isključivo na jeziku korisnika. Jezik korisnika je: ${languageCode}

              VAŽNO:
              - Ako korisnik piše na stranom jeziku (npr. ruski), ceo odgovor mora biti isključivo na tom jeziku. Ne smeš mešati srpski sa stranim jezikom.
              - Odgovori uvek moraju biti kompletno na jednom jeziku — onom koji koristi korisnik.
              - Ako pišeš na ruskom jeziku, koristi formalni ton („вы“), piši prirodnim, tečnim ruskim jezikom kao izvorni govornik.

              Informacije o restoranu su sledeće:
              ${trainingData}

              Ako korisnik pita za meni, prikaži sve kategorije i pitaj ga koja ga kategorija zanima.

              Ako korisnik želi da naruči, objasni mu da narudžbine prihvatamo isključivo uživo putem konobara u restoranu.

              Budi jasan, prijateljski i profesionalan u svakoj situaciji.
              
              Rezervacije se ostavljaju putem telefona ili na linku ispod (ne šalji link nikakav biće poslati kasnije u okviru funkcije iRQ), a narudžbine su putem konobara isključivo.
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
      rawReply += `\n\n<a href="${rezervacijaLink}" target="_blank" rel="noopener noreferrer">link</a>`;
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
