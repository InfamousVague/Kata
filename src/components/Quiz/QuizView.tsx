import { useState } from "react";
import type { QuizLesson, QuizQuestion } from "../../data/types";
import { normalizeAnswer } from "../../data/types";
import "./QuizView.css";

interface Props {
  lesson: QuizLesson;
  onComplete: () => void;
}

type QuestionState =
  | { status: "unanswered" }
  | { status: "correct" }
  | { status: "wrong" };

/// Renders a checkpoint quiz. Each question can be answered independently;
/// the lesson counts as complete only when every question is correct. Wrong
/// answers reveal the explanation and allow retry. No scoring — concept
/// retention is the point, not hitting a number.
export default function QuizView({ lesson, onComplete }: Props) {
  const [state, setState] = useState<QuestionState[]>(() =>
    lesson.questions.map(() => ({ status: "unanswered" })),
  );

  const allCorrect = state.every((s) => s.status === "correct");

  function setQuestionState(index: number, next: QuestionState) {
    setState((prev) => {
      const copy = prev.slice();
      copy[index] = next;
      const done = copy.every((s) => s.status === "correct");
      if (done && !allCorrect) {
        // All green — bubble completion up. Fire in a microtask so the state
        // update commits first.
        queueMicrotask(onComplete);
      }
      return copy;
    });
  }

  return (
    <div className="kata-quiz">
      <div className="kata-quiz-progress">
        {lesson.questions.map((_, i) => (
          <span
            key={i}
            className={`kata-quiz-pip kata-quiz-pip--${state[i].status}`}
            aria-hidden
          />
        ))}
        <span className="kata-quiz-progress-label">
          {state.filter((s) => s.status === "correct").length} / {lesson.questions.length}
        </span>
      </div>

      {lesson.questions.map((q, i) => (
        <QuestionCard
          key={i}
          index={i}
          question={q}
          state={state[i]}
          onResult={(status) => setQuestionState(i, { status })}
        />
      ))}

      {allCorrect && (
        <div className="kata-quiz-done">nice — checkpoint cleared</div>
      )}
    </div>
  );
}

function QuestionCard({
  index,
  question,
  state,
  onResult,
}: {
  index: number;
  question: QuizQuestion;
  state: QuestionState;
  onResult: (status: "correct" | "wrong") => void;
}) {
  return (
    <div className={`kata-quiz-card kata-quiz-card--${state.status}`}>
      <div className="kata-quiz-num">{index + 1}</div>
      <div className="kata-quiz-q-body">
        <div className="kata-quiz-prompt">{question.prompt}</div>
        {question.kind === "mcq" ? (
          <McqAnswer question={question} state={state} onResult={onResult} />
        ) : (
          <ShortAnswer question={question} state={state} onResult={onResult} />
        )}
        {state.status !== "unanswered" && question.explanation && (
          <div className="kata-quiz-explanation">{question.explanation}</div>
        )}
      </div>
    </div>
  );
}

function McqAnswer({
  question,
  state,
  onResult,
}: {
  question: Extract<QuizQuestion, { kind: "mcq" }>;
  state: QuestionState;
  onResult: (status: "correct" | "wrong") => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const committed = state.status !== "unanswered";

  function submit(i: number) {
    if (committed) return;
    setPicked(i);
    onResult(i === question.correctIndex ? "correct" : "wrong");
  }

  return (
    <div className="kata-quiz-options">
      {question.options.map((opt, i) => {
        const isPicked = i === picked;
        const isCorrect = i === question.correctIndex;
        const classes = [
          "kata-quiz-option",
          committed && isCorrect ? "kata-quiz-option--correct" : "",
          committed && isPicked && !isCorrect ? "kata-quiz-option--wrong" : "",
        ].join(" ");
        return (
          <button
            key={i}
            className={classes}
            onClick={() => submit(i)}
            disabled={committed && state.status === "correct"}
          >
            <span className="kata-quiz-option-letter">{String.fromCharCode(65 + i)}</span>
            <span>{opt}</span>
          </button>
        );
      })}
    </div>
  );
}

function ShortAnswer({
  question,
  state,
  onResult,
}: {
  question: Extract<QuizQuestion, { kind: "short" }>;
  state: QuestionState;
  onResult: (status: "correct" | "wrong") => void;
}) {
  const [value, setValue] = useState("");
  const committed = state.status === "correct";

  function submit() {
    if (committed) return;
    const normalized = normalizeAnswer(value);
    const ok = question.accept.some((a) => normalizeAnswer(a) === normalized);
    onResult(ok ? "correct" : "wrong");
  }

  return (
    <div className="kata-quiz-short">
      <input
        className="kata-quiz-short-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="type your answer"
        disabled={committed}
      />
      <button
        className="kata-quiz-short-submit"
        onClick={submit}
        disabled={committed || !value.trim()}
      >
        {committed ? "✓" : "check"}
      </button>
    </div>
  );
}
