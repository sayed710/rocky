"""Reference fixture for chess-core atomic legality: [fen, "sorted legal uci ..."] rows from python-chess.
Half the walks steer the side to move's king toward the enemy king, so connected-king positions,
king-capture temptations and two-king explosions are well represented.
Regenerate (python-chess 1.11.2; byte-identical output):
  python -I atomic-reference.gen.py 127 40 atomic-reference.json
"""
import json
import random
import sys

import chess
import chess.variant as v

rng = random.Random(int(sys.argv[1]))
walks = int(sys.argv[2])
rows = {}


def dist(a, b):
    return max(abs(chess.square_file(a) - chess.square_file(b)), abs(chess.square_rank(a) - chess.square_rank(b)))


def record(b):
    rows.setdefault(b.fen(), ' '.join(sorted(m.uci() for m in b.legal_moves)))


for w in range(walks):
    b = v.AtomicBoard()
    steer = w % 2 == 1
    for _ in range(160):
        if b.is_game_over():
            break
        record(b)
        moves = list(b.legal_moves)
        if steer and rng.random() < 0.6:
            mine, theirs = b.king(b.turn), b.king(not b.turn)
            closer = [m for m in moves if m.from_square == mine and dist(m.to_square, theirs) < dist(mine, theirs)]
            if closer:
                moves = closer
        b.push(rng.choice(sorted(moves, key=lambda m: m.uci())))

# Targeted positions: castling next to the enemy king, connected kings with checks, two-king explosions.
for fen in [
    '8/8/8/8/8/8/3k4/R3K2R w KQ - 0 1',            # enemy king next to the castling path
    '8/8/8/8/8/8/5k2/R3K2R w KQ - 0 1',
    'r3k2r/3K4/8/8/8/8/8/8 b kq - 0 1',
    '8/8/8/3k4/3K4/8/8/3r4 w - - 0 1',             # connected kings, rook "checks" through
    '8/8/8/2k5/3K4/8/8/7b w - - 0 1',
    '8/8/2n5/3k4/3K4/8/8/8 w - - 0 1',
    '8/8/3k4/3p4/3K4/8/8/8 w - - 0 1',
    '8/8/1n1k4/8/2NK4/8/8/8 w - - 0 1',            # Nxb6/Nxd6-style explosions near both kings
]:
    record(v.AtomicBoard(fen))
repro = v.AtomicBoard()  # the #127 reproduction line, recorded ply by ply
for uci in 'e2e3 e7e6 e1e2 e8e7 e2d3 e7d6 d3d4 e6e5'.split():
    repro.push_uci(uci)
    record(repro)

json.dump(sorted(rows.items()), open(sys.argv[3], 'w'), separators=(',', ':'))
adj = sum(1 for f in rows if (lambda b: b.king(True) is not None and b.king(False) is not None and dist(b.king(True), b.king(False)) == 1)(v.AtomicBoard(f)))
print('positions', len(rows), 'connected-king positions', adj)
