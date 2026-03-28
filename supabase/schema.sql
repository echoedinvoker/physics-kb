-- Physics KB: User System Schema
-- Clerk + Supabase Third-Party Auth
-- All user_id fields are TEXT (Clerk ID format: "user_2abc...")
-- RLS uses auth.jwt()->>'sub' (NOT auth.uid())

-- ============================================================
-- 1. Core Data Tables (public, read-only for users)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.concepts (
  id TEXT PRIMARY KEY,           -- concept title (e.g. "日心說")
  name TEXT NOT NULL,            -- same as id, for clarity
  description TEXT DEFAULT '',   -- first line summary
  prerequisites TEXT[] DEFAULT '{}'  -- array of concept ids
);

CREATE TABLE IF NOT EXISTS public.concept_prerequisites (
  concept_id TEXT NOT NULL REFERENCES public.concepts(id),
  prerequisite_id TEXT NOT NULL REFERENCES public.concepts(id),
  PRIMARY KEY (concept_id, prerequisite_id)
);

CREATE TABLE IF NOT EXISTS public.questions (
  id TEXT PRIMARY KEY,           -- note title (e.g. "Q-astronomy-copernicus-center-01")
  concept_id TEXT NOT NULL REFERENCES public.concepts(id),
  body JSONB NOT NULL,           -- { stem, choices, answer, explanation }
  difficulty TEXT DEFAULT 'basic'
);

-- ============================================================
-- 2. User Data Tables (per-user, RLS protected)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.question_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES public.questions(id),
  concept_id TEXT NOT NULL REFERENCES public.concepts(id),
  is_correct BOOLEAN NOT NULL,
  answered_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.concept_mastery (
  user_id TEXT NOT NULL,
  concept_id TEXT NOT NULL REFERENCES public.concepts(id),
  correct_count INTEGER DEFAULT 0,
  is_mastered BOOLEAN DEFAULT false,
  mastered_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, concept_id)
);

CREATE TABLE IF NOT EXISTS public.daily_challenge_attempts (
  user_id TEXT NOT NULL,
  challenge_date DATE NOT NULL,
  is_correct BOOLEAN NOT NULL,
  answered_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, challenge_date)
);

CREATE TABLE IF NOT EXISTS public.user_streaks (
  user_id TEXT PRIMARY KEY,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_correct_date DATE
);

-- ============================================================
-- 3. Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_question_attempts_user
  ON public.question_attempts (user_id);
CREATE INDEX IF NOT EXISTS idx_question_attempts_user_concept
  ON public.question_attempts (user_id, concept_id);
CREATE INDEX IF NOT EXISTS idx_questions_concept
  ON public.questions (concept_id);

-- ============================================================
-- 4. Enable RLS on all tables
-- ============================================================

ALTER TABLE public.concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_prerequisites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_mastery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_challenge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. RLS Policies
-- ============================================================

-- Public tables: anyone can read
CREATE POLICY "concepts_select" ON public.concepts
  FOR SELECT USING (true);

CREATE POLICY "concept_prerequisites_select" ON public.concept_prerequisites
  FOR SELECT USING (true);

CREATE POLICY "questions_select" ON public.questions
  FOR SELECT USING (true);

-- User tables: only own data
CREATE POLICY "question_attempts_select" ON public.question_attempts
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

CREATE POLICY "question_attempts_insert" ON public.question_attempts
  FOR INSERT WITH CHECK (user_id = (auth.jwt()->>'sub'));

CREATE POLICY "concept_mastery_select" ON public.concept_mastery
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

CREATE POLICY "daily_challenge_attempts_select" ON public.daily_challenge_attempts
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

CREATE POLICY "daily_challenge_attempts_insert" ON public.daily_challenge_attempts
  FOR INSERT WITH CHECK (user_id = (auth.jwt()->>'sub'));

CREATE POLICY "user_streaks_select" ON public.user_streaks
  FOR SELECT USING (user_id = (auth.jwt()->>'sub'));

-- ============================================================
-- 6. Trigger: Update concept_mastery on new attempt
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_mastery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_correct_count INTEGER;
BEGIN
  -- Count distinct questions answered correctly for this concept
  SELECT COUNT(DISTINCT question_id)
  INTO v_correct_count
  FROM public.question_attempts
  WHERE user_id = NEW.user_id
    AND concept_id = NEW.concept_id
    AND is_correct = true;

  -- Upsert mastery record
  INSERT INTO public.concept_mastery (user_id, concept_id, correct_count, is_mastered, mastered_at)
  VALUES (
    NEW.user_id,
    NEW.concept_id,
    v_correct_count,
    v_correct_count >= 3,
    CASE WHEN v_correct_count >= 3 THEN now() ELSE NULL END
  )
  ON CONFLICT (user_id, concept_id)
  DO UPDATE SET
    correct_count = EXCLUDED.correct_count,
    is_mastered = EXCLUDED.is_mastered,
    mastered_at = CASE
      WHEN EXCLUDED.is_mastered AND NOT concept_mastery.is_mastered THEN now()
      WHEN EXCLUDED.is_mastered THEN concept_mastery.mastered_at
      ELSE NULL
    END;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_mastery
  AFTER INSERT ON public.question_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_mastery();

-- ============================================================
-- 7. Trigger: Update user_streaks on daily challenge attempt
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_streak()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_last_date DATE;
  v_current INTEGER;
  v_longest INTEGER;
BEGIN
  -- Only count correct answers for streak
  IF NOT NEW.is_correct THEN
    RETURN NEW;
  END IF;

  -- Get current streak info
  SELECT last_correct_date, current_streak, longest_streak
  INTO v_last_date, v_current, v_longest
  FROM public.user_streaks
  WHERE user_id = NEW.user_id;

  IF NOT FOUND THEN
    -- First ever correct daily challenge
    INSERT INTO public.user_streaks (user_id, current_streak, longest_streak, last_correct_date)
    VALUES (NEW.user_id, 1, 1, NEW.challenge_date);
    RETURN NEW;
  END IF;

  IF NEW.challenge_date = v_last_date THEN
    -- Same day, no change
    RETURN NEW;
  ELSIF NEW.challenge_date = v_last_date + 1 THEN
    -- Consecutive day
    v_current := v_current + 1;
  ELSE
    -- Streak broken
    v_current := 1;
  END IF;

  IF v_current > v_longest THEN
    v_longest := v_current;
  END IF;

  UPDATE public.user_streaks
  SET current_streak = v_current,
      longest_streak = v_longest,
      last_correct_date = NEW.challenge_date
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_streak
  AFTER INSERT ON public.daily_challenge_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_streak();

-- ============================================================
-- 8. V2: Learning Events (Event Tracking)
-- ============================================================

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

-- ============================================================
-- 9. V2: User Notes (Overlay Knowledge Base)
-- ============================================================

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

-- ============================================================
-- 10. V2: Exam Edge Snapshots (Structural Data Collection)
-- ============================================================

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
