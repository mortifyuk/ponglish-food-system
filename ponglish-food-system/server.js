require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { haversineKm, validCoordinates } = require('./lib/delivery');

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined });
const currency = process.env.CURRENCY || 'EGP';
const fee = Math.max(0, Number(process.env.DELIVERY_FEE || 0));
const radiusKm = Math.max(0, Number(process.env.DELIVERY_RADIUS_KM || 10));
const publicBase = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const imageUpload = multer({ storage: multer.diskStorage({ destination: uploadDir, filename: (req,file,cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req,file,cb) => cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype)) });
const menuSeed = require('./menu-data.json').items;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_TOKEN;
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!configured || configured.length < 32 || !safeEqual(supplied, configured)) return res.status(401).json({error:'Admin authentication required'});
  next();
}
function reference() { return 'PF-' + new Date().toISOString().slice(2,10).replaceAll('-','') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function verifyKashierWebhook(data, header) {
  const apiKey = process.env.KASHIER_PAYMENT_API_KEY;
  if (!apiKey || !data || !Array.isArray(data.signatureKeys) || !header) return false;
  const keys = [...data.signatureKeys].sort();
  const payload = keys.map(k => `${k}=${encodeURIComponent(data[k] == null ? '' : String(data[k]))}`).join('&');
  const digest = crypto.createHmac('sha256', apiKey).update(payload).digest('hex');
  return safeEqual(digest.toLowerCase(), String(header).toLowerCase());
}
async function sendWhatsAppText(to, body) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return;
  const url = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v23.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}`,'Content-Type':'application/json'}, body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{preview_url:false,body}}) });
  if (!response.ok) throw new Error(`WhatsApp API returned ${response.status}`);
}
async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price NUMERIC(10,2) NOT NULL CHECK(price>=0),available BOOLEAN NOT NULL DEFAULT TRUE,image_url TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY,reference TEXT UNIQUE NOT NULL,customer_name TEXT NOT NULL,phone TEXT NOT NULL,fulfilment TEXT NOT NULL CHECK(fulfilment IN ('delivery','collection')),address TEXT,latitude DOUBLE PRECISION,longitude DOUBLE PRECISION,notes TEXT NOT NULL DEFAULT '',currency TEXT NOT NULL DEFAULT 'EGP',subtotal NUMERIC(10,2) NOT NULL,delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,total NUMERIC(10,2) NOT NULL,payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','kashier')),payment_status TEXT NOT NULL DEFAULT 'cash_due',status TEXT NOT NULL DEFAULT 'new',items JSONB NOT NULL,kashier_session_id TEXT,payment_url TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS webhook_events (id BIGSERIAL PRIMARY KEY,provider TEXT NOT NULL,event_key TEXT NOT NULL,payload JSONB NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(provider,event_key));`);
  // Seed only missing items; preserve all staff menu edits across restarts.
  for (const item of menuSeed) await pool.query('INSERT INTO menu_items(id,name,category,description,price) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[item.id,item.name,item.category,item.description,item.price]);
}

app.use('/uploads', express.static(uploadDir, { fallthrough: false, maxAge: '30d', immutable: true }));
app.get('/health', async (req,res) => { try { await pool.query('SELECT 1'); res.json({ok:true,service:'ponglish-ordering'}); } catch { res.status(503).json({ok:false}); } });
app.get('/api/config', (req,res) => { const lat=Number(process.env.RESTAURANT_LAT),lng=Number(process.env.RESTAURANT_LNG),configured=process.env.RESTAURANT_LAT!==''&&process.env.RESTAURANT_LNG!==''&&validCoordinates(lat,lng); res.json({restaurantName:process.env.RESTAURANT_NAME || 'Ponglish Food',currency,deliveryFee:fee,deliveryRadiusKm:radiusKm,deliveryConfigured:configured,restaurantLat:configured?lat:null,restaurantLng:configured?lng:null,restaurantPhone:process.env.RESTAURANT_PHONE || ''}); });
app.get('/api/menu', async (req,res,next) => { try { const r = await pool.query('SELECT id,name,category,description,price::float AS price,image_url FROM menu_items WHERE available=true ORDER BY category,name'); res.json({items:r.rows}); } catch(e){next(e);} });
app.post('/api/orders', async (req,res,next) => {
  const {customerName,phone,fulfilment,address,latitude,longitude,notes,paymentMethod,items} = req.body || {};
  if (!String(customerName||'').trim() || !String(phone||'').trim() || !Array.isArray(items) || items.length < 1 || items.length > 40) return res.status(400).json({error:'Name, phone and at least one menu item are required.'});
  if (!['delivery','collection'].includes(fulfilment) || !['cash','kashier'].includes(paymentMethod)) return res.status(400).json({error:'Choose a valid fulfilment and payment method.'});
  if (paymentMethod==='kashier' && (!process.env.KASHIER_MERCHANT_ID || !process.env.KASHIER_API_KEY || !process.env.KASHIER_SECRET_KEY)) return res.status(503).json({error:'Online payment is not configured yet. Please choose cash or contact the restaurant.'});
  if (fulfilment === 'delivery') {
    const rLat = Number(process.env.RESTAURANT_LAT), rLng = Number(process.env.RESTAURANT_LNG), lat = Number(latitude), lng = Number(longitude);
    if (!validCoordinates(rLat,rLng)) return res.status(503).json({error:'Delivery is not configured yet. Please choose collection or contact the restaurant.'});
    if (!String(address||'').trim() || !validCoordinates(lat,lng)) return res.status(400).json({error:'For delivery, enter your address and select coordinates from the map pin fields.'});
    const distance = haversineKm(rLat,rLng,lat,lng);
    if (distance > radiusKm) return res.status(422).json({error:`This address is ${distance.toFixed(1)} km away, outside our ${radiusKm} km delivery radius. Please choose collection.`});
  }
  try {
    const ids = [...new Set(items.map(i => String(i.id || '')))];
    const found = await pool.query('SELECT id,name,price::float AS price,available FROM menu_items WHERE id=ANY($1::text[])', [ids]);
    const byId = new Map(found.rows.map(x=>[x.id,x])); const clean=[]; let subtotal=0;
    for (const raw of items) {
      const product=byId.get(String(raw.id||'')); const qty=Number(raw.quantity);
      if (!product || !product.available || !Number.isInteger(qty) || qty < 1 || qty > 30) return res.status(400).json({error:'A menu item is unavailable or a quantity is invalid. Refresh the menu and try again.'});
      subtotal += product.price * qty; clean.push({id:product.id,name:product.name,unitPrice:product.price,quantity:qty,lineTotal:Number((product.price*qty).toFixed(2))});
    }
    subtotal=Number(subtotal.toFixed(2)); const deliveryFee=fulfilment==='delivery'?fee:0; const total=Number((subtotal+deliveryFee).toFixed(2)); const ref=reference();
    const paymentStatus=paymentMethod==='cash'?'cash_due':'pending';
    const inserted=await pool.query(`INSERT INTO orders(reference,customer_name,phone,fulfilment,address,latitude,longitude,notes,currency,subtotal,delivery_fee,total,payment_method,payment_status,status,items)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'new',$15::jsonb) RETURNING id,reference,total::float AS total,payment_status,status`,
      [ref,String(customerName).trim().slice(0,120),String(phone).trim().slice(0,40),fulfilment,String(address||'').trim().slice(0,500),latitude==null?null:Number(latitude),longitude==null?null:Number(longitude),String(notes||'').slice(0,1000),currency,subtotal,deliveryFee,total,paymentMethod,paymentStatus,JSON.stringify(clean)]);
    const order=inserted.rows[0]; let paymentUrl=null;
    if(paymentMethod==='kashier') {
      if(!process.env.KASHIER_MERCHANT_ID || !process.env.KASHIER_API_KEY || !process.env.KASHIER_SECRET_KEY) return res.status(503).json({error:'Online payment is not configured yet. The order is saved as pending; please contact the restaurant before retrying.',orderReference:ref});
      const test=String(process.env.KASHIER_MODE||'test').toLowerCase()!=='live';
      const response=await fetch(`${test?'https://test-api.kashier.io':'https://api.kashier.io'}/v3/payment/sessions`,{method:'POST',headers:{Authorization:process.env.KASHIER_SECRET_KEY,'api-key':process.env.KASHIER_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({amount:total.toFixed(2),currency,order:ref,merchantRedirect:`${publicBase}/payment-return.html?order=${encodeURIComponent(ref)}`,type:'one-time',allowedMethods:'card,wallet',merchantId:process.env.KASHIER_MERCHANT_ID,serverWebhook:`${publicBase}/webhooks/kashier`,description:`Ponglish Food order ${ref}`,customer:{reference:phone}})});
      const result=await response.json().catch(()=>({}));
      const sessionUrl=result.sessionUrl||result.data?.sessionUrl||result.response?.sessionUrl;
      if(!response.ok || !sessionUrl) { console.error('Kashier session creation failed',response.status); return res.status(502).json({error:'Could not start Kashier checkout. The order has not been confirmed; please contact the restaurant.',orderReference:ref}); }
      paymentUrl=sessionUrl;
      await pool.query('UPDATE orders SET kashier_session_id=$1,payment_url=$2,updated_at=NOW() WHERE reference=$3',[result.sessionId||result.data?.sessionId||result.id||null,paymentUrl,ref]);
    }
    const whatsappText=`New Ponglish Food order ${ref}\n${clean.map(i=>`${i.quantity} x ${i.name} — ${currency} ${i.lineTotal.toFixed(2)}`).join('\n')}\nSubtotal: ${currency} ${subtotal.toFixed(2)}\nDelivery: ${currency} ${deliveryFee.toFixed(2)}\nTotal: ${currency} ${total.toFixed(2)}\n${fulfilment.toUpperCase()} · ${paymentMethod==='cash'?'CASH DUE':'KASHIER '+paymentStatus.toUpperCase()}\nCustomer: ${String(customerName).trim()} · ${String(phone).trim()}\n${String(address||'')}`;
    // The browser can open a WhatsApp deep link for staff as a fallback; official API notification is separately configurable.
    res.status(201).json({orderReference:ref,total,currency,paymentStatus,paymentUrl,whatsappMessage:whatsappText,order:{...order,total}});
    if(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.RESTAURANT_PHONE) sendWhatsAppText(process.env.RESTAURANT_PHONE,whatsappText).catch(e=>console.error('WhatsApp notification failed:',e.message));
  } catch(e){next(e);}
});

app.get('/api/admin/orders',requireAdmin,async(req,res,next)=>{try{const r=await pool.query(`SELECT id,reference,customer_name,phone,fulfilment,address,latitude,longitude,notes,currency,subtotal::float AS subtotal,delivery_fee::float AS delivery_fee,total::float AS total,payment_method,payment_status,status,items,created_at FROM orders ORDER BY created_at DESC LIMIT 250`);res.json({orders:r.rows});}catch(e){next(e);}});
app.patch('/api/admin/orders/:reference',requireAdmin,async(req,res,next)=>{const {status,paymentStatus,confirmCashReceived}=req.body||{};const allowedStatus=['new','accepted','preparing','ready','completed','rejected'];const allowedPay=['cash_due','paid','pending','failed','refunded'];if(status&&!allowedStatus.includes(status))return res.status(400).json({error:'Invalid order status'});if(paymentStatus&&!allowedPay.includes(paymentStatus))return res.status(400).json({error:'Invalid payment status'});try{const current=await pool.query('SELECT payment_method,payment_status FROM orders WHERE reference=$1',[req.params.reference]);if(!current.rowCount)return res.status(404).json({error:'Order not found'});if(paymentStatus==='paid' && !(current.rows[0].payment_method==='cash' && confirmCashReceived===true))return res.status(400).json({error:'Online payments can only be marked paid by a verified Kashier webhook. Cash requires explicit confirmation of receipt.'});if(status==='completed' && paymentStatus!=='paid' && current.rows[0].payment_status!=='paid' && !(current.rows[0].payment_method==='cash'&&confirmCashReceived===true))return res.status(400).json({error:'Mark payment received before completing the order.'});const r=await pool.query('UPDATE orders SET status=COALESCE($1,status),payment_status=COALESCE($2,payment_status),updated_at=NOW() WHERE reference=$3 RETURNING reference,status,payment_status',[status||null,paymentStatus==='paid'&&confirmCashReceived===true?'paid':paymentStatus||null,req.params.reference]);res.json({order:r.rows[0]});}catch(e){next(e);}});
app.get('/api/admin/menu',requireAdmin,async(req,res,next)=>{try{const r=await pool.query('SELECT id,name,category,description,price::float AS price,available,image_url FROM menu_items ORDER BY category,name');res.json({items:r.rows});}catch(e){next(e);}});
app.post('/api/admin/menu',requireAdmin,async(req,res,next)=>{try{const {id,name,category,description='',price,available=true,imageUrl=null}=req.body||{};const cleanName=String(name||'').trim(),cleanCategory=String(category||'').trim(),amount=Number(price);if(!cleanName||!cleanCategory||!Number.isFinite(amount)||amount<0)return res.status(400).json({error:'Name, category and a valid non-negative price are required.'});const itemId=String(id||crypto.randomUUID());const r=await pool.query('INSERT INTO menu_items(id,name,category,description,price,available,image_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,category,description,price::float AS price,available,image_url',[itemId,cleanName.slice(0,160),cleanCategory.slice(0,100),String(description||'').slice(0,1000),amount,available!==false,imageUrl]);res.status(201).json({item:r.rows[0]});}catch(e){if(e.code==='23505')return res.status(409).json({error:'That menu item ID already exists.'});next(e);}});
app.post('/api/admin/menu/upload',requireAdmin,(req,res,next)=>{imageUpload.single('image')(req,res,err=>{if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Image must be 5MB or smaller.':'Upload a JPG, PNG, WebP or GIF image.'});if(!req.file)return res.status(400).json({error:'Choose an image file.'});res.status(201).json({imageUrl:'/uploads/'+req.file.filename});});});
app.delete('/api/admin/menu/:id',requireAdmin,async(req,res,next)=>{try{const r=await pool.query('DELETE FROM menu_items WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Menu item not found'});res.json({deleted:true,id:r.rows[0].id});}catch(e){next(e);}});
app.patch('/api/admin/menu/:id',requireAdmin,async(req,res,next)=>{try{const {available,price,name,description,category,imageUrl}=req.body||{};const r=await pool.query(`UPDATE menu_items SET available=COALESCE($1,available),price=COALESCE($2,price),name=COALESCE($3,name),description=COALESCE($4,description),category=COALESCE($5,category),image_url=COALESCE($6,image_url) WHERE id=$7 RETURNING id,name,category,description,price::float AS price,available,image_url`,[typeof available==='boolean'?available:null,price===undefined?null:Number(price),name||null,description===undefined?null:description,category||null,imageUrl===undefined?null:imageUrl,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Menu item not found'});res.json({item:r.rows[0]});}catch(e){next(e);}});

app.get('/webhooks/whatsapp', (req,res)=>{const mode=req.query['hub.mode'];const token=req.query['hub.verify_token'];const challenge=req.query['hub.challenge'];if(mode==='subscribe'&&safeEqual(String(token||''),String(process.env.WHATSAPP_VERIFY_TOKEN||'!unset!')))return res.status(200).send(String(challenge||''));res.sendStatus(403);});
app.post('/webhooks/whatsapp',async(req,res)=>{try{const secret=process.env.WHATSAPP_APP_SECRET;const signature=req.get('x-hub-signature-256');if(!secret&&process.env.NODE_ENV==='production')return res.sendStatus(503);if(secret){const expected='sha256='+crypto.createHmac('sha256',secret).update(req.rawBody||Buffer.from('')).digest('hex');if(!safeEqual(signature,expected))return res.sendStatus(401);}const body=req.body||{};for(const entry of body.entry||[])for(const change of entry.changes||[])for(const msg of change.value?.messages||[]){if(msg.type==='text'&&msg.id){const seen=await pool.query('INSERT INTO webhook_events(provider,event_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(provider,event_key) DO NOTHING RETURNING id',['whatsapp',String(msg.id),JSON.stringify(msg)]);if(!seen.rowCount)continue;const from=msg.from;const link=`${publicBase}/`;await sendWhatsAppText(from,`Welcome to Ponglish Food! Browse our menu and place your order here: ${link}`);}}res.sendStatus(200);}catch(e){console.error('WhatsApp webhook error:',e.message);res.sendStatus(200);}});
app.post('/webhooks/kashier',async(req,res)=>{try{const data=req.body?.data;if(!verifyKashierWebhook(data,req.get('x-kashier-signature')))return res.sendStatus(401);const transactionId=String(data.transactionId||data.kashierOrderId||data.orderReference||'unknown');const eventKey=`${transactionId}:${data.status||'unknown'}`;const inserted=await pool.query('INSERT INTO webhook_events(provider,event_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(provider,event_key) DO NOTHING RETURNING id',['kashier',eventKey,JSON.stringify(req.body)]);if(!inserted.rowCount)return res.sendStatus(409);const ref=String(data.orderReference||data.merchantOrderId||'');const amount=Number(data.amount);const status=String(data.status||'').toUpperCase();if(status==='SUCCESS'&&ref){const r=await pool.query('SELECT total::float AS total,currency,payment_status FROM orders WHERE reference=$1',[ref]);if(r.rowCount && Math.abs(r.rows[0].total-amount)<0.011 && r.rows[0].currency===String(data.currency||currency) && r.rows[0].payment_status!=='paid'){await pool.query("UPDATE orders SET payment_status='paid',updated_at=NOW() WHERE reference=$1 AND payment_method='kashier'",[ref]);}}else if(status==='FAILURE'&&ref){await pool.query("UPDATE orders SET payment_status='failed',updated_at=NOW() WHERE reference=$1 AND payment_method='kashier' AND payment_status='pending'",[ref]);}return res.sendStatus(200);}catch(e){console.error('Kashier webhook error:',e.message);return res.sendStatus(500);}});
app.get('/api/orders/:reference',async(req,res,next)=>{try{const r=await pool.query('SELECT reference,fulfilment,currency,subtotal::float AS subtotal,delivery_fee::float AS delivery_fee,total::float AS total,payment_method,payment_status,status,items,created_at FROM orders WHERE reference=$1',[req.params.reference]);if(!r.rowCount)return res.status(404).json({error:'Order not found'});res.json({order:r.rows[0]});}catch(e){next(e);}});
app.use(express.static('public',{extensions:['html']}));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'Unexpected server error. Please try again or contact the restaurant.'});});
const port=Number(process.env.PORT||3000);
init().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Ponglish ordering listening on ${port}`))).catch(e=>{console.error('Startup failed:',e);process.exit(1);});
