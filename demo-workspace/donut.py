import math
import time
import os
import sys

WIDTH = 80
HEIGHT = 22
CHARS = ".,-~:;=!*#$@"

def render_frame(A: float, B: float) -> str:
    z = [0.0] * (WIDTH * HEIGHT)
    b = [" "] * (WIDTH * HEIGHT)

    for j_idx in range(0, 628, 7):
        for i_idx in range(0, 628, 2):
            i = i_idx / 100.0
            j = j_idx / 100.0

            c = math.sin(i)
            d = math.cos(j)
            e = math.sin(A)
            f = math.sin(j)
            g = math.cos(A)
            h = d + 2
            D = 1.0 / (c * h * e + f * g + 5.0)
            l = math.cos(i)
            m = math.cos(B)
            n = math.sin(B)

            t = c * h * g - f * e

            x = int(WIDTH / 2 + 30 * D * (l * h * m - t * n))
            y = int(HEIGHT / 2 + 15 * D * (l * h * n + t * m))

            if 0 <= x < WIDTH and 0 <= y < HEIGHT:
                o = x + WIDTH * y
                if D > z[o]:
                    z[o] = D

                    N = int(
                        8
                        * (
                            (f * e - c * d * g) * m
                            - c * d * e
                            - f * g
                            - l * d * n
                        )
                    )

                    char_idx = max(0, min(N, 11))
                    b[o] = CHARS[char_idx]

    output_lines = []
    for ky in range(HEIGHT):
        line = ""
        for kx in range(WIDTH):
            idx = kx + WIDTH * ky
            line += b[idx]
        output_lines.append(line)
    return "\n".join(output_lines)


def main():
    A = 0.0
    B = 0.0
    try:
        while True:
            frame = render_frame(A, B)
            # Use ANSI escape to clear screen and move cursor home
            sys.stdout.write("\x1b[H" + frame)
            sys.stdout.flush()
            A += 0.04
            B += 0.02
            time.sleep(0.03)
    except KeyboardInterrupt:
        print("\nDonut renderer stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
