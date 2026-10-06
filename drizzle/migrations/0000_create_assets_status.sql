CREATE TABLE public.assets_status (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 symbol text NOT NULL UNIQUE,
 name text,
 current_price numeric,
 stable_signal text CHECK (stable_signal IN ('Green', 'Yellow', 'Red')),
 stable_explanation text,
 radar_signal text CHECK (radar_signal IN ('Green', 'Yellow', 'Red')),
 risk_pct numeric,
 radar_explanation text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.assets_status TO anon, authenticated;
GRANT ALL ON public.assets_status TO service_role;
ALTER TABLE public.assets_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public market signals are readable" ON public.assets_status FOR SELECT TO anon, authenticated USING (true);