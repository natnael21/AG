-- Customer Portal Enhancements Migration
-- Adds customer portal authentication, appointments, and session management

-- Add portal authentication fields to customers table
ALTER TABLE customers
ADD COLUMN portal_password_hash VARCHAR(255),
ADD COLUMN portal_enabled BOOLEAN DEFAULT false,
ADD COLUMN last_portal_login TIMESTAMP WITH TIME ZONE;

-- Create customer sessions table for portal authentication
CREATE TABLE customer_sessions (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for session token lookups
CREATE INDEX idx_customer_sessions_token ON customer_sessions(session_token);
CREATE INDEX idx_customer_sessions_customer_id ON customer_sessions(customer_id);
CREATE INDEX idx_customer_sessions_expires_at ON customer_sessions(expires_at);

-- Create appointments table for customer scheduling
CREATE TABLE appointments (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  preferred_date DATE NOT NULL,
  preferred_time TIME,
  concern TEXT NOT NULL,
  contact_method VARCHAR(50) DEFAULT 'email' CHECK (contact_method IN ('email', 'phone', 'text')),
  notes TEXT,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  confirmed_date TIMESTAMP WITH TIME ZONE,
  confirmed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for appointments
CREATE INDEX idx_appointments_customer_id ON appointments(customer_id);
CREATE INDEX idx_appointments_vehicle_id ON appointments(vehicle_id);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_preferred_date ON appointments(preferred_date);
CREATE INDEX idx_appointments_created_at ON appointments(created_at);

-- Add feedback table for customer satisfaction tracking
CREATE TABLE feedback (
  id SERIAL PRIMARY KEY,
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comments TEXT,
  feedback_type VARCHAR(50) DEFAULT 'repair_order' CHECK (feedback_type IN ('repair_order', 'appointment', 'general')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for feedback
CREATE INDEX idx_feedback_repair_order_id ON feedback(repair_order_id);
CREATE INDEX idx_feedback_customer_id ON feedback(customer_id);
CREATE INDEX idx_feedback_type ON feedback(feedback_type);
CREATE INDEX idx_feedback_created_at ON feedback(created_at);

-- Add trigger to update updated_at timestamp for appointments
CREATE OR REPLACE FUNCTION update_appointments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION update_appointments_updated_at();

-- Add some useful views for reporting

-- Customer portal summary view
CREATE VIEW customer_portal_summary AS
SELECT
  c.id,
  c.full_name,
  c.email,
  c.portal_enabled,
  c.last_portal_login,
  COUNT(DISTINCT v.id) as vehicle_count,
  COUNT(DISTINCT ro.id) as repair_order_count,
  COALESCE(SUM(ro.total_final), 0) as total_spent,
  MAX(ro.created_at) as last_service_date,
  AVG(f.rating) as avg_rating
FROM customers c
LEFT JOIN vehicles v ON c.id = v.customer_id
LEFT JOIN repair_orders ro ON c.id = ro.customer_id
LEFT JOIN feedback f ON c.id = f.customer_id
GROUP BY c.id, c.full_name, c.email, c.portal_enabled, c.last_portal_login;

-- Appointment summary view
CREATE VIEW appointment_summary AS
SELECT
  a.*,
  c.full_name as customer_name,
  c.email as customer_email,
  c.phone as customer_phone,
  v.year, v.make, v.model, v.plate,
  u.name as confirmed_by_name
FROM appointments a
JOIN customers c ON a.customer_id = c.id
JOIN vehicles v ON a.vehicle_id = v.id
LEFT JOIN users u ON a.confirmed_by = u.id;