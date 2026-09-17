#!/usr/bin/env python3
"""
Python generation as a parallel line grid.

Jev makes every structural decision through parallel Choice questions —
line roles, indentation, identifiers, loop counts, what to print, how to
update running values — and body lines that need expression detail are
drafted one TOKEN per round with every active line asked in a single
parallel call. Verification embeds each line's content in its own
question (Jev weighs the question, not the state JSON), and broken lines
are repaired in parallel with full draft context.
"""

import ast
import time
from concurrent.futures import ThreadPoolExecutor

from typesafe_sdk import Choice, Noul, TypeSafeClient


GRID_ROWS = 9
MAX_TOKENS_PER_ROW = 12
REPAIR_ROUNDS = 3

STOP = "<STOP>"

ROLE_CRITERIA = {
    "blank": "An empty line; this row stays blank.",
    "comment": "A comment line starting with #.",
    "import": "An import statement.",
    "def_line": "A function definition line like 'def name(args):'.",
    "loop": "A loop line like 'for ... in ...:' or 'while ...:'.",
    "assignment": "An assignment like 'x = ...'.",
    "print": "A print(...) call.",
    "call": "A top-level call to the defined function, like name(args).",
    "return": "A return statement.",
    "other": "Any other valid Python line.",
}

NAME_CRITERIA = {
    "fibonacci": "The function computes Fibonacci numbers.",
    "fib": "Shorter name for a Fibonacci function.",
    "fibonnaci": "Alternative spelling some programs use.",
}

PARAM_CRITERIA = {
    "n": "The number of terms to produce.",
    "count": "The number of terms to produce.",
    "terms": "The number of terms to produce.",
}

LOOP_COUNT_CRITERIA = {
    "10": "The first 10 Fibonacci numbers are wanted.",
    "n": "Loop over the function parameter n.",
    "other": "A different count.",
}

LOOP_VAR_CRITERIA = {
    "_": "The loop index is not used in the body.",
    "i": "A conventional loop index name.",
    "k": "Another conventional loop index name.",
}

INDENT_CRITERIA = {
    "0": "Top level, no indentation.",
    "1": "Inside the function definition.",
    "2": "Inside a loop that is inside the function.",
}

VAR1_CRITERIA = {
    "a": "Conventional short name for a running value.",
    "x": "Another conventional short name.",
    "current": "Descriptive name for the current value.",
}

VAR2_CRITERIA = {
    "b": "Conventional short name for the next value.",
    "y": "Another conventional short name.",
    "nxt": "Descriptive name for the next value.",
}

PRINT_WHAT_CRITERIA = {
    "running_value": "The running value the loop advances each iteration.",
    "loop_index": "The loop counter variable.",
    "other": "Something else.",
}

UPDATE_STYLE_CRITERIA = {
    "pair_swap": "Advance the pair of running values at once, like: "
    "a, b = b, a + b",
    "single": "Reassign one variable per line.",
    "none": "No update needed.",
    "other": "Something else.",
}


def body_tokens(names: dict[str, str]) -> dict[str, str | None]:
    """Token alphabet for body lines; identifiers come from the plan."""

    tokens: dict[str, str | None] = {
        STOP: "The line is complete.",
        "    ": "One indentation level (4 spaces).",
        " ": "A single space.",
        "for ": None,
        "while ": None,
        "in ": None,
        " in ": "The keyword 'in', preceded by one space.",
        "range(": None,
        "return ": None,
        "a": None,
        "b": None,
        "i": None,
        "_": None,
        ", ": None,
        " = ": None,
        " + ": None,
        "0": None,
        "1": None,
        "10": None,
        "n": None,
        "(": None,
        ")": None,
        ":": None,
    }

    name = names["def_name"]
    param = names["def_param"]
    tokens[name] = "The function's name, chosen in the plan."
    tokens[name + "("] = f"Call to the {name} function."
    tokens[param] = "The function's parameter."
    tokens[names["var1"]] = "The first running value from the plan."
    tokens[names["var2"]] = "The second running value from the plan."

    return tokens


def def_line_seed(names: dict[str, str]) -> str:
    """Synthesize the def line from the plan's identifier choices."""

    return f"def {names['def_name']}({names['def_param']}):"


def call_line_seed(names: dict[str, str]) -> str | None:
    """Synthesize the top-level call from the plan's choices, when countable."""

    count = names.get("loop_count", "")
    if count.isdigit():
        return f"{names['def_name']}({count})"
    return None


def plan_lines(
    client: TypeSafeClient,
    objective: str,
    rows: int,
    *,
    rejection: str | None = None,
) -> tuple[list[str], dict[str, str]]:
    """One parallel call: roles, indents, and key identifiers per line.

    Rejected plans are re-planned with the rejection reason in context.
    """

    note = (
        f"Plan a Python program satisfying objective as exactly {rows} "
        "numbered lines, top to bottom. Give each row a role. The program "
        "defines exactly one function. The plan must produce a COMPLETE "
        "runnable program: the function body needs initialization, a loop, "
        "printing each number inside the loop, and updating the running "
        "values inside the loop, and the program must call the function so "
        "the printing actually happens. Rows the program does not need are "
        "blank. Do not repeat a role unless the program truly needs the "
        "same kind of line twice in a row."
    )
    if rejection:
        note += f" A previous plan was rejected: {rejection}"

    questions: dict[str, Choice] = {
        f"role_{row}": Choice(
            instructions=(
                f"What kind of line is row {row} of the planned program?"
            ),
            criteria=ROLE_CRITERIA,
        )
        for row in range(rows)
    }
    questions.update(
        {
            "def_name": Choice(
                instructions=(
                    "If the program defines a function, what is its name?"
                ),
                criteria=NAME_CRITERIA,
            ),
            "def_param": Choice(
                instructions=(
                    "If the program defines a function taking one argument, "
                    "what is that argument called?"
                ),
                criteria=PARAM_CRITERIA,
            ),
            "loop_count": Choice(
                instructions=(
                    "If the program loops to produce numbers, how many "
                    "iterations does the loop need?"
                ),
                criteria=LOOP_COUNT_CRITERIA,
            ),
            "loop_var": Choice(
                instructions=(
                    "If the program loops, what is the loop variable called?"
                ),
                criteria=LOOP_VAR_CRITERIA,
            ),
            "var1": Choice(
                instructions=(
                    "If the loop advances a running value that gets "
                    "printed, what is that value called?"
                ),
                criteria=VAR1_CRITERIA,
            ),
            "var2": Choice(
                instructions=(
                    "If the loop advances a second running value (the next "
                    "number), what is it called?"
                ),
                criteria=VAR2_CRITERIA,
            ),
            "print_what": Choice(
                instructions=(
                    "Inside the loop, what does the program print?"
                ),
                criteria=PRINT_WHAT_CRITERIA,
            ),
            "update_style": Choice(
                instructions=(
                    "Inside the loop, how does the program update its "
                    "running values?"
                ),
                criteria=UPDATE_STYLE_CRITERIA,
            ),
        }
    )

    response = client.system_one(
        state={"objective": objective, "note": note},
        questions=questions,
    )

    roles = [response.choices[f"role_{row}"].choice for row in range(rows)]

    # Enforce the plan's own constraint: exactly one def_line.
    seen_def = False
    for row, role in enumerate(roles):
        if role == "def_line":
            if seen_def:
                roles[row] = "blank"
            seen_def = True

    names = {
        "def_name": response.choices["def_name"].choice,
        "def_param": response.choices["def_param"].choice,
        "loop_count": response.choices["loop_count"].choice,
        "loop_var": response.choices["loop_var"].choice,
        "var1": response.choices["var1"].choice,
        "var2": response.choices["var2"].choice,
        "print_what": response.choices["print_what"].choice,
        "update_style": response.choices["update_style"].choice,
    }

    return roles, names


def plan_ok_question(roles: list[str], objective: str) -> Noul:
    sketch = "\n".join(
        f"    {row:02d} {role}" for row, role in enumerate(roles)
    )
    return Noul(
        instructions=(
            "A program for objective is planned as a sequence of line "
            f"roles:\n{sketch}\n"
            "Is this role plan a complete, correct structure for objective? "
            "It must define one function, initialize, loop, print each "
            "number, update the running values, and call the function. "
            "Answer no if roles are duplicated where variety is needed, or "
            "if a needed part of the program is missing."
        ),
    )


def plan_program(
    client: TypeSafeClient,
    objective: str,
    rows: int,
) -> tuple[list[str], dict[str, str]]:
    """Plan, verify the plan, and re-plan up to twice on rejection."""

    rejection: str | None = None
    for _ in range(3):
        roles, names = plan_lines(
            client, objective, rows, rejection=rejection
        )
        verdict = client.system_one(
            state={"objective": objective},
            questions={"plan_ok": plan_ok_question(roles, objective)},
        ).nouls["plan_ok"].noul

        if verdict >= 0.5:
            return roles, names

        rejection = (
            f"the previous role plan scored {verdict:.2f} on completeness "
            "and coherence; produce a better plan"
        )
        print(f"  plan rejected (noul={verdict:.2f}), re-planning")

    return roles, names


def derive_indents(roles: list[str]) -> list[int]:
    """Indentation levels follow from the role sequence itself.

    Top-level roles and rows before the def sit at 0. Function body rows
    sit at 1; rows between the loop and the call are the loop body at 2.
    """

    def_row = roles.index("def_line") if "def_line" in roles else -1
    call_row = next(
        (row for row, role in enumerate(roles) if role == "call"),
        len(roles),
    )
    first_loop = next(
        (row for row, role in enumerate(roles) if role == "loop"),
        None,
    )

    levels: list[int] = []
    for row, role in enumerate(roles):
        if role in ("def_line", "call", "blank", "import"):
            levels.append(0)
        elif row < def_row:
            levels.append(0)
        elif first_loop is not None and row == first_loop:
            levels.append(1)
        elif first_loop is not None and first_loop < row < call_row:
            levels.append(2)
        else:
            levels.append(1)

    return levels


def next_token_criteria(
    tokens_so_far: str,
    names: dict[str, str],
) -> dict[str, str | None]:
    """Token alphabet; <STOP> stays unavailable until the line has content."""

    criteria = body_tokens(names)
    if not tokens_so_far.strip():
        criteria.pop(STOP)
    return criteria


def next_token_question(
    row: int,
    tokens_so_far: str,
    above: list[str],
    role: str,
    names: dict[str, str],
) -> Choice:
    context = "\n".join(f"    |{line}|" for line in above) or "    (none)"
    return Choice(
        instructions=(
            "A Python program for objective is being written line by line.\n"
            f"Lines already written above line {row}:\n"
            f"{context}\n"
            f"Line {row} must be the next line of that program. Its "
            f"planned role: {role}. Its current content is "
            f"{tokens_so_far!r}. Which single token comes next? Choose "
            "<STOP> to end the line at the previous token."
        ),
        criteria=next_token_criteria(tokens_so_far, names),
    )


def print_line_seed(names: dict[str, str], loop_var: str) -> str | None:
    """Synthesize the loop's print line from the plan's slot."""

    what = names["print_what"]
    if what == "running_value":
        return f"print({names['var1']})"
    if what == "loop_index":
        return f"print({loop_var})"
    return None


def update_line_seed(names: dict[str, str]) -> str | None:
    """Synthesize the loop's update line from the plan's slot."""

    if names["update_style"] == "pair_swap":
        var1, var2 = names["var1"], names["var2"]
        return f"{var1}, {var2} = {var2}, {var1} + {var2}"
    return None


def build_synthesis(
    roles: list[str],
    indents: list[int],
    names: dict[str, str],
) -> dict[int, str]:
    """Deterministic lines derived from the plan's structural choices.

    The def and call lines are pure boilerplate around chosen identifiers.
    Init assignments become var1/var2 seeds; the loop header and its
    print/update lines follow from the plan's slots. Surplus rows the
    plan over-allocated are demoted to blank. Everything left over is
    token-drafted by the wavefront.
    """

    synthesis: dict[int, str] = {}

    # The top-level call must exist; the last row donates itself.
    if "def_line" in roles and "call" not in roles:
        roles[-1] = "call"
        indents[-1] = 0

    def_row = roles.index("def_line") if "def_line" in roles else -1
    first_loop = next(
        (row for row, role in enumerate(roles) if role == "loop"), None
    )

    init_slot = 0
    seeds = ["{var1} = 0", "{var2} = 1"]
    update_done = False
    for row, role in enumerate(roles):
        pad = "    " * indents[row]
        if role == "def_line":
            synthesis[row] = def_line_seed(names)
        elif role == "call":
            seed = call_line_seed(names)
            if seed is not None:
                synthesis[row] = pad + seed
        elif role == "print":
            seed = print_line_seed(names, names["loop_var"])
            if seed is not None:
                synthesis[row] = pad + seed
        elif role == "loop":
            count = names["loop_count"]
            if count == "other":
                count = names["def_param"]
            synthesis[row] = pad + f"for {names['loop_var']} in range({count}):"
        elif role == "assignment" and first_loop is not None:
            if row < first_loop and init_slot < len(seeds):
                synthesis[row] = pad + seeds[init_slot].format(**names)
                init_slot += 1
            elif row < first_loop:
                # Surplus init assignment: demote to blank.
                roles[row] = "blank"
            elif row > first_loop and not update_done:
                seed = update_line_seed(names)
                if seed is not None:
                    synthesis[row] = pad + seed
                    update_done = True
            elif row > first_loop:
                # Surplus update assignment: demote to blank.
                roles[row] = "blank"

    return synthesis


def token_wavefront(
    client: TypeSafeClient,
    objective: str,
    rows: int,
    roles: list[str],
    indents: list[int],
    names: dict[str, str],
    synthesis: dict[int, str],
) -> list[str]:
    """Synthesize what the plan determines; token-generate the rest in parallel."""

    lines = [""] * rows
    finished = [False] * rows
    input_tokens = 0
    output_tokens = 0

    for row in range(rows):
        if row in synthesis:
            lines[row] = synthesis[row]
            finished[row] = True
        elif roles[row] != "blank":
            # Token-drafted lines start at their planned indentation.
            lines[row] = "    " * indents[row]

    for _ in range(MAX_TOKENS_PER_ROW):
        active = [
            row for row in range(rows)
            if not finished[row] and roles[row] != "blank"
        ]
        if not active:
            break

        questions = {
            f"line_{row}": next_token_question(
                row,
                lines[row],
                lines[:row],
                roles[row],
                names,
            )
            for row in active
        }
        response = client.system_one(
            state={"objective": objective},
            questions=questions,
        )
        input_tokens += response.usage.input_tokens or 0
        output_tokens += response.usage.output_tokens or 0

        for name, answer in response.choices.items():
            row = int(name.removeprefix("line_"))
            label = max(answer.probabilities, key=answer.probabilities.get)
            if label == STOP:
                finished[row] = True
                continue
            lines[row] += label

    print(f"\n(token wavefront: {input_tokens} in / {output_tokens} out)")
    return lines


def row_ok_question(
    row: int,
    line: str,
    role: str,
    above: list[str],
    objective: str,
) -> Noul:
    context = "\n".join(f"    |{line_}|" for line_ in above) or "    (none)"
    return Noul(
        instructions=(
            f"A program is being written for objective:\n"
            f"{objective}\n"
            f"Lines written above line {row}:\n{context}\n"
            f"Line {row} is:\n    |{line}|\n"
            f"Line {row}'s planned role: {role}.\n"
            f"Judge only line {row}: is it a correct, meaningful line for "
            "its role in this program? A blank line for a blank role is "
            "correct. Answer no for mangled fragments, stray characters, "
            "or lines that do not serve objective."
        ),
    )


def verify_rows(
    client: TypeSafeClient,
    objective: str,
    lines: list[str],
    roles: list[str],
) -> list[float]:
    """One call, one noul per line; each line is embedded in its question."""

    questions = {
        f"line_{row}_ok": row_ok_question(
            row, lines[row], roles[row], lines[:row], objective
        )
        for row in range(len(lines))
    }
    response = client.system_one(
        state={"objective": objective},
        questions=questions,
    )

    return [
        response.nouls[f"line_{row}_ok"].noul
        for row in range(len(lines))
    ]


def repair_rows(
    client: TypeSafeClient,
    objective: str,
    lines: list[str],
    bad_rows: list[int],
    roles: list[str],
    indents: list[int],
    names: dict[str, str],
    synthesis: dict[int, str],
) -> list[str]:
    """Re-write every bad line in parallel, token by token, with context."""

    def repair(row: int) -> str:
        if row in synthesis:
            return synthesis[row]

        tokens_so_far = "    " * indents[row]
        for _ in range(MAX_TOKENS_PER_ROW):
            response = client.system_one(
                state={
                    "objective": objective,
                    "draft_program": "\n".join(lines),
                    "note": (
                        f"Replace line {row} of draft_program. Every other "
                        "line stays exactly as written."
                    ),
                },
                questions={
                    "next": next_token_question(
                        row,
                        tokens_so_far,
                        lines[:row],
                        roles[row],
                        names,
                    ),
                },
            )
            answer = response.choices["next"]
            label = max(answer.probabilities, key=answer.probabilities.get)
            if label == STOP:
                break
            tokens_so_far += label
        return tokens_so_far

    with ThreadPoolExecutor(max_workers=min(len(bad_rows), 8)) as pool:
        replacements = list(pool.map(repair, bad_rows))

    repaired = list(lines)
    for row, replacement in zip(bad_rows, replacements, strict=True):
        repaired[row] = replacement

    return repaired


def satisfies_question(objective: str, program: str) -> Noul:
    return Noul(
        instructions=(
            "A complete Python program is being checked against "
            "objective.\n"
            f"objective:\n{objective}\n"
            f"program:\n{program}\n"
            "Does program actually accomplish objective? Answer yes only "
            "if the program is coherent and does what objective asks, not "
            "merely that it parses."
        ),
    )


def generate_python_grid(
    objective: str,
    *,
    rows: int = GRID_ROWS,
    repair_rounds: int = REPAIR_ROUNDS,
) -> str:
    """Plan structure, synthesize or draft lines, verify, repair."""

    started = time.monotonic()

    with TypeSafeClient() as client:
        roles, names = plan_program(client, objective, rows)
        indents = derive_indents(roles)
        synthesis = build_synthesis(roles, indents, names)
        print(f"\nPLAN: roles={roles} names={names}")
        print(f"INDENTS: {indents}")
        print(f"SYNTHESIZED: {synthesis}")

        lines = token_wavefront(
            client, objective, rows, roles, indents, names, synthesis
        )

        print("\nDRAFT")
        print("=" * 72)
        for index, line in enumerate(lines):
            print(f"{index:02d} |{line}|")

        for round_number in range(repair_rounds):
            verdicts = verify_rows(client, objective, lines, roles)
            bad_rows = [
                row for row, verdict in enumerate(verdicts) if verdict < 0.5
            ]

            print(
                f"\nREPAIR ROUND {round_number + 1}: "
                f"{len(bad_rows)} bad line(s) of {len(lines)}"
            )
            for row, verdict in enumerate(verdicts):
                marker = "OK " if verdict >= 0.5 else "BAD"
                print(f"  {row:02d} noul={verdict:.2f} {marker} |{lines[row]}|")

            if not bad_rows:
                break

            lines = repair_rows(
                client, objective, lines, bad_rows, roles, indents, names,
                synthesis,
            )

            print("\nAFTER REPAIR")
            for index, line in enumerate(lines):
                print(f"{index:02d} |{line}|")

        program = "\n".join(line for line in lines if line.strip())

        verdict = client.system_one(
            state={"objective": objective},
            questions={"satisfies": satisfies_question(objective, program)},
        ).nouls["satisfies"].noul

    elapsed = time.monotonic() - started

    print("\nFINAL PROGRAM")
    print("=" * 72)
    print(program)

    try:
        ast.parse(program)
        status = "parses"
    except SyntaxError as exc:
        status = f"SyntaxError: {exc.msg} (line {exc.lineno})"

    print(f"\nSYNTAX: {status}")
    print(f"SATISFIES OBJECTIVE: noul={verdict:.2f}")
    print(f"WALL TIME: {elapsed:.1f}s for {rows} lines")

    return program


def main() -> None:
    objective = """
Write a Python program that defines fibonacci(n), computes the first
10 Fibonacci numbers, and prints them.
""".strip()

    generate_python_grid(objective)


if __name__ == "__main__":
    main()
