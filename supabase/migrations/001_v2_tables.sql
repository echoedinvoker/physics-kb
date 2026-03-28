-- V2 Migration: Learning Events + User Notes
-- Safe to run on prod: only creates new tables, no changes to existing ones.
-- Idempotent: uses IF NOT EXISTS / DROP POLICY IF EXISTS.

-- 1. Learning Events
CREATE TABLE IF NOT EXISTS public.learning_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  concept_id TEXT REFERENCES public.concepts(id) DEFAULT NULL,
  metadata JSONB DEFAULT '{}',
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_events_user ON public.learning_events (user_id);
CREATE INDEX IF NOT EXISTS idx_learning_events_type ON public.learning_events (event_type);
CREATE INDEX IF NOT EXISTS idx_learning_events_concept ON public.learning_events (concept_id);
CREATE INDEX IF NOT EXISTS idx_learning_events_session ON public.learning_events (session_id);

ALTER TABLE public.learning_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "learning_events_select" ON public.learning_events;
CREATE POLICY "learning_events_select" ON public.learning_events
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

DROP POLICY IF EXISTS "learning_events_insert" ON public.learning_events;
CREATE POLICY "learning_events_insert" ON public.learning_events
  FOR INSERT WITH CHECK (user_id = (auth.jwt()->>'sub'));

-- 2. User Notes (Overlay)
CREATE TABLE IF NOT EXISTS public.user_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_type TEXT NOT NULL,
  related_concepts TEXT[] DEFAULT '{}',
  source_context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_notes_updated ON public.user_notes;
CREATE TRIGGER trg_user_notes_updated
  BEFORE UPDATE ON public.user_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_user_notes_user ON public.user_notes (user_id);
CREATE INDEX IF NOT EXISTS idx_user_notes_concepts ON public.user_notes USING GIN (related_concepts);

ALTER TABLE public.user_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_notes_select" ON public.user_notes;
CREATE POLICY "user_notes_select" ON public.user_notes
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

DROP POLICY IF EXISTS "user_notes_insert" ON public.user_notes;
CREATE POLICY "user_notes_insert" ON public.user_notes
  FOR INSERT WITH CHECK (user_id = (auth.jwt()->>'sub'));

DROP POLICY IF EXISTS "user_notes_update" ON public.user_notes;
CREATE POLICY "user_notes_update" ON public.user_notes
  FOR UPDATE USING (user_id = (auth.jwt()->>'sub'));

DROP POLICY IF EXISTS "user_notes_delete" ON public.user_notes;
CREATE POLICY "user_notes_delete" ON public.user_notes
  FOR DELETE USING (user_id = (auth.jwt()->>'sub'));

-- 3. Exam Edge Snapshots (Structural Data Collection)
CREATE TABLE IF NOT EXISTS public.exam_edge_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  exam_session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  tested_concept TEXT NOT NULL REFERENCES public.concepts(id),
  prerequisite_concept TEXT NOT NULL REFERENCES public.concepts(id),
  prerequisite_mastered BOOLEAN NOT NULL,
  prerequisite_correct_count INTEGER DEFAULT 0,
  question_correct BOOLEAN NOT NULL,
  source TEXT NOT NULL DEFAULT 'exam',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exam_edges_user ON public.exam_edge_snapshots (user_id);
CREATE INDEX IF NOT EXISTS idx_exam_edges_pair ON public.exam_edge_snapshots (tested_concept, prerequisite_concept);
CREATE INDEX IF NOT EXISTS idx_exam_edges_session ON public.exam_edge_snapshots (exam_session_id);

ALTER TABLE public.exam_edge_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exam_edges_select" ON public.exam_edge_snapshots;
CREATE POLICY "exam_edges_select" ON public.exam_edge_snapshots
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

DROP POLICY IF EXISTS "exam_edges_insert" ON public.exam_edge_snapshots;
CREATE POLICY "exam_edges_insert" ON public.exam_edge_snapshots
  FOR INSERT WITH CHECK (user_id = (auth.jwt()->>'sub'));
