"""
Validation functions for bill data
"""


def evaluate_price_value(price_value: float | int | str) -> float:
    """Evaluate a price value, which can be a number, string, or formula.

    :param price_value: Price value (float, int, str, or formula string like "=4*0,19")
    :type price_value: float | int | str
    :return: Evaluated numeric price value
    :rtype: float
    :raises ValueError: If the value cannot be evaluated
    """
    # If already a number, return it
    if isinstance(price_value, (int, float)):
        return float(price_value)

    # If it's a string, handle it
    if isinstance(price_value, str):
        # Remove whitespace
        price_value = price_value.strip()

        # Check if it's a formula (starts with =)
        if price_value.startswith("="):
            # Remove the = sign
            formula: str = price_value[1:]

            # Replace comma with dot for Python evaluation
            formula = formula.replace(",", ".")

            # Evaluate the formula using eval (safe for simple math expressions)
            # Note: This only works for basic arithmetic, which is fine for prices
            try:
                return float(
                    eval(formula, {"__builtins__": {}}, {})  # pylint: disable=eval-used
                )
            except Exception as e:
                raise ValueError(f"Cannot evaluate formula '{price_value}': {e}") from e
        # Try to parse as a regular number (with comma or dot)
        try:
            return float(price_value.replace(",", "."))
        except ValueError as exc:
            raise ValueError(f"Cannot convert '{price_value}' to a number") from exc

    # If we get here, the type is unexpected
    raise ValueError(f"Unsupported price value type: {type(price_value).__name__}")


def validate_bill_total(
    bill_data: dict[str, float | int | str | list],
) -> dict[str, bool | float | str]:
    """Validate that the sum of item prices equals the total price in the bill.

    :param bill_data: Bill dictionary with 'items' and 'total' keys
    :type bill_data: dict[str, float | int | str | list]
    :return: Dictionary with validation results containing 'valid' (bool), 'calculated_sum' (float),
        'declared_total' (float), 'difference' (float), and 'message' (str)
    :rtype: dict[str, bool | float | str]
    :raises KeyError: If required keys are missing from bill_data
    :raises ValueError: If any price value cannot be evaluated
    """
    # Extract data
    items: list = bill_data.get("items", [])  # type: ignore[assignment]
    declared_total_raw = bill_data.get("total")
    declared_total: float | int | str | None = (
        declared_total_raw if not isinstance(declared_total_raw, list) else None
    )

    if declared_total is None:
        raise KeyError("Bill data is missing 'total' key")

    if not items:
        raise KeyError("Bill data is missing 'items' or items list is empty")

    # Calculate sum of all item prices
    calculated_sum: float = 0.0
    for item in items:
        price: float | int | str | None = item.get("price")
        if price is None:
            raise KeyError(
                f"Item '{item.get('name', 'Unknown')}' is missing 'price' key"
            )

        calculated_sum += evaluate_price_value(price)

    # Evaluate the declared total (in case it's a string)
    declared_total_value: float = evaluate_price_value(declared_total)

    # Calculate difference
    difference: float = abs(calculated_sum - declared_total_value)

    # Check if is valid, allow 1 cent tolerance for rounding errors
    is_valid: bool = difference < 0.01

    # Create result
    result: dict[str, bool | float | str] = {
        "valid": is_valid,
        "calculated_sum": round(calculated_sum, 2),
        "declared_total": round(declared_total_value, 2),
        "difference": round(difference, 2),
        "message": (
            "✓ Price validation passed"
            if is_valid
            else f"⚠ Price mismatch: Sum of items ({calculated_sum:.2f}€) "
            f"!= Total ({declared_total_value:.2f}€), difference: {difference:.2f}€"
        ),
    }

    return result
