-- The Service quiz's question bank. Questions from the menu are made fresh from the recipes, each
-- with a key ("allergen|<dish>|milk"); a row with that key is a manager's edit of it, or turns it
-- off. Rows with no key are the managers' own questions.
CREATE TABLE floor_quiz (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  auto_key        text,
  question        text,
  answer          text,
  wrong           jsonb NOT NULL DEFAULT '[]',          -- the other options: ["No", "Only with..."]
  why             text,                                -- shown after answering
  dish_id         uuid,                                -- the dish it's about, for the "what's new" quiz
  active          boolean NOT NULL DEFAULT true,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (auto_key IS NOT NULL OR (question IS NOT NULL AND answer IS NOT NULL))
);
CREATE UNIQUE INDEX floor_quiz_key ON floor_quiz (restaurant_id, auto_key) WHERE auto_key IS NOT NULL;
