// index.js
require('dotenv').config(); // Carrega as variáveis do .env
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
 
// Compatibilidade fetch no Node.js (CJS)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pasta pública (inclui/uploads)
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Certifique-se que a pasta existe
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// armazenamento de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// --- CONFIGURAÇÃO ---
const CONFIG_FILE = path.join(__dirname, 'config.json');
let CONFIG = {
  mainWebhook: 'https://discord.com/api/webhooks/1430367755839868938/tM2Vrs_oi4_Ed4V_bOfEJQmpZPngVcYmvodDaGXWva4aIlkehnoiORkN7KITE6_A5jqM',
  deliveryWebhook: 'https://discord.com/api/webhooks/1430711036763443220/Fni2w5ykMuj89pdeW8_HDmyGs4m9GFXnDMUsYPQ6shR6g8Pe81e34xyMJyBnzDFvD1_N',
  mainMessageId: '1430373050779697288'
};

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      CONFIG = { ...CONFIG, ...savedConfig };
      console.log('Configurações carregadas de config.json');
    } catch (e) {
      console.error('Erro ao ler config.json:', e);
    }
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
}

// Estoque padrão (usado para popular o banco de dados na primeira execução)
const defaultStock = [
  { id: "TOMATRIO", name: "TOMATRIO", emoji: "🍅", quantity: 202, price: 0.50, max: 300 },
  { id: "MANGO", name: "MANGO", emoji: "🥭", quantity: 260, price: 0.70, max: 300 },
  { id: "MR_CARROT", name: "MR CARROT", emoji: "🥕", quantity: 74, price: 0.40, max: 150 },
  { id: "PLANTA", name: "PLANTA (100k ~ 500k DPS)", emoji: "🌱", quantity: 12, price: 7.50, max: 20 }
];

// Função para popular o banco de dados com o estoque padrão se estiver vazio
async function seedDatabase() {
  const itemCount = await prisma.stockItem.count();
  if (itemCount === 0) {
    console.log('Banco de dados de estoque vazio. Populando com dados padrão...');
    await prisma.stockItem.createMany({
      data: defaultStock,
    });
    console.log('Banco de dados populado.');
  }
}

// ---------- endpoints API ---------- //

// Get/Save Config
app.get('/get-config', (req, res) => {
  res.json(CONFIG);
});

app.post('/save-config', (req, res) => {
  const { mainWebhook, deliveryWebhook } = req.body;
  if (mainWebhook !== undefined) CONFIG.mainWebhook = mainWebhook;
  if (deliveryWebhook !== undefined) CONFIG.deliveryWebhook = deliveryWebhook;
  saveConfig();
  console.log('Configurações salvas:', CONFIG);
  res.json({ status: 'success', message: 'Configurações salvas.' });
});

// Get stock (front-end)
app.get('/get-stock', async (req, res) => {
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  res.json(stock);
});

// Add new fruit (creates entry in stock.json and returns updated list)
app.post('/add-fruit', async (req, res) => {
  const { id, name, emoji, price, quantity, max } = req.body;
  if (!id || !name) return res.status(400).json({ status: 'error', message: 'id e name obrigatórios' });

  const existingItem = await prisma.stockItem.findUnique({ where: { id: String(id).toUpperCase().replace(/\s+/g, '_') } });
  if (existingItem) {
    return res.status(400).json({ status: 'error', message: 'ID já existe' });
  }

  const newItemData = {
    id: String(id).toUpperCase().replace(/\s+/g, '_'),
    name: name.toUpperCase(),
    emoji: emoji || '',
    price: Number(price) || 0,
    quantity: Number(quantity) || 0,
    max: Number(max) || (Number(quantity) || 100)
  };

  const item = await prisma.stockItem.create({ data: newItemData });
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  return res.json({ status: 'success', stock, item });
});

// Update stock/prices (from panel)
app.post('/update-stock', async (req, res) => {
  const newStock = req.body; // keys like TOMATRIO_quantity, TOMATRIO_price
  const currentStock = await prisma.stockItem.findMany();

  const updatePromises = currentStock.map(item => {
    const quantityKey = `${item.id}_quantity`;
    const priceKey = `${item.id}_price`;

    const dataToUpdate = {};
    if (newStock[quantityKey] !== undefined) {
      dataToUpdate.quantity = parseInt(newStock[quantityKey], 10);
    }
    if (newStock[priceKey] !== undefined) {
      dataToUpdate.price = parseFloat(newStock[priceKey]);
    }

    if (Object.keys(dataToUpdate).length > 0) {
      return prisma.stockItem.update({ where: { id: item.id }, data: dataToUpdate });
    }
    return Promise.resolve();
  });

  await Promise.all(updatePromises);

  // optionally update main embed if mainMessageId & mainWebhookURL configured
  if (CONFIG.mainWebhook && CONFIG.mainMessageId) updateMainEmbed().catch(err => console.error('Erro updateMainEmbed:', err));
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  res.json({ status: 'success', stock });
});

// Set which message id to read/update for main embed
app.post('/set-message-id', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ status: 'error', message: 'id requerido' });
  CONFIG.mainMessageId = id;
  saveConfig(); // Salva o novo ID da mensagem
  // try fetch to populate stock from that embed
  try {
    await fetchSelectedMessage();
    res.json({ status: 'success', message: 'messageId setado', mainMessageId: CONFIG.mainMessageId });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'erro ao ler mensagem', err: String(err) });
  }
});

// Deliveries: create delivery (with optional file upload)
// Fields expected: webhook (delivery webhook URL), mention (string), itemId, quantity, note (optional)
// multipart/form-data with file field 'photo' (optional)
app.post('/deliver', upload.single('photo'), async (req, res) => {
  try {
    const webhook = CONFIG.deliveryWebhook; // Usa o webhook salvo
    const { mention, itemId, quantity, note } = req.body;
    if (!webhook) return res.status(400).json({ status: 'error', message: 'Webhook de entrega não configurado no painel.' });
    if (!itemId) return res.status(400).json({ status: 'error', message: 'itemId requerido' });

    const item = await prisma.stockItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ status: 'error', message: 'item não encontrado' });

    const qty = Number(quantity) || 1;

    // save photo URL if uploaded
    let photoUrl = null;
    if (req.file) {
      photoUrl = `${getServerBaseUrl(req)}/uploads/${req.file.filename}`;
    }

    // build embed payload for delivery
    const embed = {
      title: '📦 Entrega Confirmada',
      color: 3066993,
      thumbnail: photoUrl ? { url: photoUrl } : undefined,
      fields: [
        { name: 'Destinatário', value: mention || 'Não informado', inline: true },
        { name: 'Produto', value: `${item.emoji} ${item.name}`, inline: true },
        { name: 'Quantidade', value: String(qty), inline: true },
        { name: 'Preço Unit.', value: `R$${item.price.toFixed(2)}`, inline: true },
      ],
      description: note ? `${note}` : undefined,
      footer: { text: 'DOLLYA STORE — Entrega' }
    };

    // Para a menção funcionar, ela precisa estar no campo "content".
    // Também verificamos se o usuário digitou um ID numérico e o formatamos corretamente.
    let content = mention || '';
    if (/^\d{17,19}$/.test(content)) {
      content = `<@${content}>`;
    }

    // send to provided webhook
    const body = {
      content: content, // A menção vai aqui para notificar o usuário
      username: 'DOLLYA - Entregas',
      avatar_url: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/fd/c8/4a/fdc84a19-2df7-4205-a233-7e3d794688d6/1963623074713_cover.png/600x600bf-60.jpg', // opcional
      embeds: [embed]
    };

    const resWebhook = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // save delivery log to database
    const deliveryRecord = await prisma.deliveryRecord.create({
      data: {
        mention: mention || null,
        itemId,
        itemName: item.name,
        quantity: qty,
        photoUrl,
        webhookSent: resWebhook.ok,
        webhookStatus: resWebhook.status
      }
    });

    res.json({ status: 'success', delivery: deliveryRecord, webhookStatus: resWebhook.status });
  } catch (err) {
    console.error('Erro em /deliver:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// Get deliveries history
app.get('/get-deliveries', async (req, res) => {
  const deliveries = await prisma.deliveryRecord.findMany({ orderBy: { timestamp: 'desc' } });
  res.json(deliveries);
});

// Serve frontend
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- helper functions ---------- //

// get base url from request
function getServerBaseUrl(req) {
  // If behind proxy, you might want to use X-Forwarded-Proto/header; this is a simple approach
  const host = req.get('host');
  const proto = req.protocol;
  return `${proto}://${host}`;
}

// generate main embed from stock (if you want to update the main store embed)
async function generateMainEmbed() {
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  return {
    username: "DOLLYA VS BRAINROTS [PREÇOS]",
    avatar_url: "", // optional
    embeds: [{
      title: "🧠 DOLLYA STORE | TABELA DE PREÇOS",
      color: 16753920,
      fields: stock.map(item => ({
        name: `${item.emoji} ${item.name}`,
        value: `**Preço:** R$${item.price.toFixed(2)}\n**Estoque:** ${item.quantity > 0 ? item.quantity : 'ESGOTADO'}`,
        inline: true
      })),
      footer: { text: '🛒 DOLLYA STORE' }
    }]
  };
}

// update the main embed (if configured)
async function updateMainEmbed() {
  if (!CONFIG.mainWebhook || !CONFIG.mainMessageId) {
    console.log('Webhook principal ou ID da mensagem não configurados; pulando updateMainEmbed.');
    return;
  }
  try {
    await fetch(`${CONFIG.mainWebhook}/messages/${CONFIG.mainMessageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await generateMainEmbed())
    });
    console.log('Main embed atualizado.');
  } catch (err) {
    console.error('Erro ao atualizar main embed:', err);
  }
}

// read selected message to populate stock (if you used a message to store stock)
async function fetchSelectedMessage() {
  if (!CONFIG.mainWebhook || !CONFIG.mainMessageId) {
    console.log('Webhook/ID da mensagem não configurados para leitura.');
    return;
  }
  try {
    const res = await fetch(`${CONFIG.mainWebhook}/messages/${CONFIG.mainMessageId}`);
    const data = await res.json();
    if (data && data.embeds && data.embeds.length > 0) {
      console.log('Lendo embed do Discord para atualizar estoque local...');
      const fields = data.embeds[0].fields || [];
      
      const currentStock = await prisma.stockItem.findMany();
      const updatePromises = [];

      // Itera sobre os campos do embed para atualizar o estoque local
      fields.forEach(field => {
        // Encontra o item correspondente no estoque local pelo nome
        const itemInStock = currentStock.find(item => field.name.includes(item.name));
        
        if (itemInStock) {
          const cleaned = String(field.value).replace(/\*\*/g, '');
          const matchQty = cleaned.match(/Estoque:\s*([0-9]+|ESGOTADO)/i);
          const matchPrice = cleaned.match(/Preço:\s*R\$([\d,.]+)/i);

          const dataToUpdate = {};
          if (matchQty) {
            dataToUpdate.quantity = matchQty[1].toUpperCase() === 'ESGOTADO' ? 0 : parseInt(matchQty[1], 10);
          }
          if (matchPrice) {
            dataToUpdate.price = parseFloat(matchPrice[1].replace(',', '.'));
          }
          if (Object.keys(dataToUpdate).length > 0) {
            updatePromises.push(prisma.stockItem.update({ where: { id: itemInStock.id }, data: dataToUpdate }));
          }
        }
      });

      await Promise.all(updatePromises);
      console.log('Estoque local atualizado com base na mensagem do Discord. Itens novos foram preservados.');
    }
  } catch (err) {
    console.error('Erro ao buscar mensagem selecionada:', err);
  }
}

async function startServer() {
  // --- PASSO DE DEBUG ---
  // Verifique se a variável de ambiente foi carregada.
  // Se isso mostrar 'undefined', o problema está no seu arquivo .env ou no diretório.
  console.log('Verificando DATABASE_URL:', process.env.DATABASE_URL ? 'Encontrada!' : 'NÃO ENCONTRADA!');
  if (!process.env.DATABASE_URL) {
    console.error('Erro Crítico: A variável de ambiente DATABASE_URL não foi definida. Verifique seu arquivo .env.');
    process.exit(1); // Encerra a aplicação se o DB não estiver configurado.
  }

  // 1. Carrega as configurações do config.json
  loadConfig();

  // 2. Popula o banco de dados se necessário
  await seedDatabase();

  // 3. Sincroniza com o Discord se configurado
  if (CONFIG.mainWebhook && CONFIG.mainMessageId) {
    await fetchSelectedMessage();
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando e pronto na porta ${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Falha ao iniciar o servidor:", err);
  process.exit(1);
});
