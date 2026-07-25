for n in range(-100, 101):
    if (n**5 - n) % 30 != 0:
        print(f"Counterexample at n={n}")
        exit(1)
print("All tested values satisfy divisibility by 30.")