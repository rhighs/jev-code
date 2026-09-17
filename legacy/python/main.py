#!/usr/bin/env python3

import ast
import keyword
import math
import string
import tokenize
from concurrent.futures import ThreadPoolExecutor

from typesafe_sdk import Choice, Noul, TypeSafeClient


BEAM_WIDTH = 3
EPSILON = 1e-9

STOP = "<STOP>"
SPACE = "<SPACE>"
NEWLINE = "<NEWLINE>"
TAB = "<TAB>"


def python_symbols() -> dict[str, str | None]:
    """
    Finite alphabet from which Jev must choose.

    Character-level generation means arbitrary ASCII Python source can
    eventually be constructed, while STOP terminates generation.
    """

    symbols: dict[str, str | None] = {
        STOP: None,
        SPACE: " ",
        NEWLINE: "\n",
        TAB: "\t",
    }

    for ch in string.ascii_letters + string.digits + string.punctuation:
        symbols[ch] = ch

    return symbols


SYMBOLS = python_symbols()


def choice_criteria() -> dict[str, str]:
    criteria: dict[str, str] = {}

    for name, value in SYMBOLS.items():
        if name == STOP:
            criteria[name] = (
                "Stop generating. Choose this only when the current Python "
                "program is complete and satisfies the requested objective."
            )
        elif name == SPACE:
            criteria[name] = "Append one ASCII space."
        elif name == NEWLINE:
            criteria[name] = "Append one newline."
        elif name == TAB:
            criteria[name] = "Append one tab."
        else:
            criteria[name] = f"Append the character {value!r}."

    return criteria


NEXT_SYMBOL = Choice(
    instructions=(
        "Choose exactly one next symbol to append to current_program. "
        "Your goal is to construct a correct Python 3 program satisfying "
        "objective. Treat current_program as an exact prefix: do not rewrite "
        "or remove anything already present. Select STOP only once the program "
        "is complete. Prefer syntactically and semantically coherent Python."
    ),
    criteria=choice_criteria(),
)


ON_TRACK = Noul(
    instructions=(
        "Does current_program, as it stands, read like plausible Python 3 "
        "progressing toward objective? Answer no if the program is drifting: "
        "meaningless character repetition, symbols that do not advance a "
        "coherent program, or code unrelated to objective. An incomplete "
        "prefix is not drifting if it can still be completed sensibly."
    ),
)

SATISFIES = Noul(
    instructions=(
        "Does this complete Python program satisfy objective? Answer yes "
        "only if the program is coherent and actually accomplishes what "
        "objective asks for, not merely that it runs or parses."
    ),
)

FINALIST_COUNT = 12


def syntax_state(program: str) -> dict:
    """
    Give Jev deterministic feedback about the prefix it has constructed.

    A SyntaxError does NOT necessarily mean the generation is wrong:
    `def foo(` is obviously incomplete but can become valid after more symbols.
    """

    if not program:
        return {
            "parses": True,
            "note": "The program is currently empty.",
        }

    try:
        ast.parse(program)

        return {
            "parses": True,
            "note": "The current source is syntactically valid Python.",
        }

    except SyntaxError as exc:
        return {
            "parses": False,
            "error": exc.msg,
            "line": exc.lineno,
            "offset": exc.offset,
            "note": (
                "The current source may simply be an incomplete prefix. "
                "Continue it if another symbol can make it valid."
            ),
        }


def build_state(objective: str, program: str, turn: int) -> dict:
    """
    Everything Jev sees on every generation step.
    """

    return {
        "task": {
            "type": "incremental_python_generation",
            "objective": objective,
        },

        "python_language": {
            "version": "Python 3",
            "keywords": keyword.kwlist,

            # Python's recognized operator/delimiter lexemes.
            "operators_and_delimiters": sorted(
                tokenize.EXACT_TOKEN_TYPES.keys()
            ),

            # The actual output alphabet available on this turn.
            "available_symbols": {
                name: repr(value) if value is not None else "STOP"
                for name, value in SYMBOLS.items()
            },
        },

        "generation": {
            "turn": turn,
            "current_program": program,
            "current_program_length": len(program),
            "syntax": syntax_state(program),
        },

        "rules": [
            "The current program is an immutable prefix.",
            "Choose exactly one available symbol.",
            "The chosen symbol will be appended verbatim.",
            "Do not stop until the objective is satisfied.",
            "Do not output explanations or prose.",
        ],
    }


def decode_symbol(choice: str) -> str | None:
    if choice not in SYMBOLS:
        raise ValueError(f"Unknown Jev choice: {choice!r}")

    return SYMBOLS[choice]


def ask_symbols(
    client: TypeSafeClient,
    objective: str,
    program: str,
    turn: int,
) -> tuple[dict[str, float], float]:
    """Ask Jev for one candidate's next-symbol distribution and on-track signal."""

    response = client.system_one(
        state=build_state(objective, program, turn),
        questions={
            "next_symbol": NEXT_SYMBOL,
            "on_track": ON_TRACK,
        },
    )

    answer = response.answers["next_symbol"]
    on_track = response.nouls["on_track"].noul

    return answer.probabilities, on_track


def is_degenerate(program: str, *, window: int = 30, min_distinct: int = 3) -> bool:
    """True when a candidate has fallen into a self-reinforcing loop."""

    tail = program[-window:]
    return len(tail) == window and len(set(tail)) < min_distinct


def extend(
    candidate: dict,
    label: str,
    probability: float,
) -> dict:
    """Append one edge and recompute the geometric-mean path score."""

    stopped = label == STOP
    log_probability = candidate["logp"] + math.log(max(probability, EPSILON))
    decisions = candidate["decisions"] + 1
    program = candidate["program"] if stopped else candidate["program"] + decode_symbol(label)

    return {
        "program": program,
        "logp": log_probability,
        "decisions": decisions,
        "score": math.exp(log_probability / decisions),
        "stopped": stopped,
    }


def generate_python(
    objective: str,
    *,
    seed: str = "",
    max_turns: int = 1000,
    beam_width: int = BEAM_WIDTH,
) -> str:
    """
    Beam search over per-character Choice distributions.

    Greedy per-step selection drifts into garbage: one early mistake is
    unrecoverable. Following the TypeSafe hierarchical-classification
    pattern, each turn asks Jev for the full symbol distribution of every
    beam candidate in parallel, extends every candidate with each option,
    scores paths by product(edge_probabilities) ** (1 / decisions), and
    keeps the best `beam_width` growing paths. A path that selects STOP
    finishes; it is only kept as a result when the program it built parses.
    """

    beam = [
        {
            "program": seed,
            "logp": 0.0,
            "decisions": 0,
            "score": 1.0,
            "stopped": False,
        }
    ]
    finished: list[dict] = []

    with TypeSafeClient() as client, ThreadPoolExecutor(max_workers=beam_width) as pool:
        for turn in range(max_turns):
            responses = list(
                pool.map(
                    lambda candidate: ask_symbols(
                        client,
                        objective,
                        candidate["program"],
                        turn,
                    ),
                    beam,
                )
            )

            # Drop candidates Jev itself flags as drifting; when every
            # candidate looks off-track, keep them anyway rather than
            # have nothing to expand.
            pairs = [
                (candidate, response)
                for candidate, response in zip(beam, responses, strict=True)
            ]
            on_track_pairs = [
                (candidate, response)
                for candidate, response in pairs
                if response[1] >= 0.5
            ]
            if on_track_pairs:
                pairs = on_track_pairs

            # Expand every surviving candidate with every option, then
            # dedupe: distinct paths that reach the same text keep only
            # their best score.
            unique: dict[str, dict] = {}
            for candidate, (distribution, _) in pairs:
                for label, probability in distribution.items():
                    extension = extend(candidate, label, probability)
                    if is_degenerate(extension["program"]):
                        continue
                    previous = unique.get(extension["program"])
                    if previous is None or extension["score"] > previous["score"]:
                        unique[extension["program"]] = extension

            finished.extend(
                extension
                for extension in unique.values()
                if extension["stopped"]
                and syntax_state(extension["program"])["parses"]
            )

            growing = [
                extension
                for extension in unique.values()
                if not extension["stopped"]
            ]

            if not growing:
                break

            beam = sorted(
                growing,
                key=lambda c: c["score"],
                reverse=True,
            )[:beam_width]

            best = beam[0]
            print(
                f"{turn:04d} "
                f"score={best['score']:.4f} "
                f"length={len(best['program'])} "
                f"finished={len(finished)}"
            )
            print(best["program"])
            print("-" * 72)

        else:
            print(f"\nStopped after reaching max_turns={max_turns}.")

        candidates = sorted(
            finished + beam,
            key=lambda c: c["score"],
            reverse=True,
        )

        # Prefer programs Jev actually finished (it chose STOP) over
        # never-stopped beam leftovers. Rank finished candidates by Jev's own
        # judgment of whether they satisfy the objective, breaking ties by
        # path score.
        finished_by_program: dict[str, dict] = {}
        for candidate in finished:
            previous = finished_by_program.get(candidate["program"])
            if previous is None or candidate["score"] > previous["score"]:
                finished_by_program[candidate["program"]] = candidate

        finalists = sorted(
            finished_by_program.values(),
            key=lambda c: c["score"],
            reverse=True,
        )[:FINALIST_COUNT]

        if finalists:
            verdicts = list(
                pool.map(
                    lambda finalist: client.system_one(
                        state={
                            "objective": objective,
                            "program": finalist["program"],
                        },
                        questions={"satisfies": SATISFIES},
                    ).nouls["satisfies"].noul,
                    finalists,
                )
            )

            for finalist, verdict in zip(finalists, verdicts, strict=True):
                finalist["verdict"] = verdict

            finalists.sort(key=lambda c: (c["verdict"], c["score"]), reverse=True)

            best = finalists[0]
            if best["verdict"] >= 0.5:
                print(
                    f"\nBest program: satisfies={best['verdict']:.2f} "
                    f"score={best['score']:.4f} "
                    f"length={len(best['program'])}"
                )
                return best["program"]

        ordered = sorted(beam, key=lambda c: c["score"], reverse=True)

        for candidate in ordered:
            if syntax_state(candidate["program"])["parses"]:
                print(
                    f"\nBest program: score={candidate['score']:.4f} "
                    f"length={len(candidate['program'])}"
                )
                return candidate["program"]

        return candidates[0]["program"] if candidates else seed

    return seed


def main() -> None:
    objective = """
Write a Python program that defines fibonacci(n), computes the first
10 Fibonacci numbers, and prints them.
""".strip()

    program = generate_python(
        objective,
        max_turns=300,
    )

    print("\nFINAL PROGRAM")
    print("=" * 72)
    print(program)

    print("\nFINAL SYNTAX STATUS")
    print(syntax_state(program))


if __name__ == "__main__":
    main()
