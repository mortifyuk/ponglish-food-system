CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0), available BOOLEAN NOT NULL DEFAULT TRUE,
  image_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL,
  phone TEXT NOT NULL, fulfilment TEXT NOT NULL CHECK (fulfilment IN ('delivery','collection')),
  address TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  notes TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'EGP',
  subtotal NUMERIC(10,2) NOT NULL, delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL, payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','kashier')),
  payment_status TEXT NOT NULL DEFAULT 'cash_due', status TEXT NOT NULL DEFAULT 'new',
  items JSONB NOT NULL, kashier_session_id TEXT, payment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, event_key TEXT NOT NULL, payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(provider, event_key)
);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, payment_status);
