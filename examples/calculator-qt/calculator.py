import sys
import re
from collections import deque
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QGridLayout,
    QLineEdit, QPushButton, QSizePolicy
)
from PySide6.QtCore import Qt

class CalculatorError(Exception):
    """Custom exception for calculator errors."""
    pass

class CalculatorEngine:
    """
    Handles parsing and evaluation of arithmetic expressions.
    Uses the Shunting-Yard algorithm to convert infix to RPN, then evaluates RPN.
    Supports basic arithmetic operations (+, -, *, /) and floating-point numbers.
    Handles unary minus.
    """
    def __init__(self) -> None:
        # Precedence: higher number means higher precedence
        # Unary minus has higher precedence than binary multiplication/division
        self.precedence = {'+': 1, '-': 1, '*': 2, '/': 2, '_UNARY_MINUS': 3}
        # Associativity: 'L' for left-associative, 'R' for right-associative
        self.associativity = {'+': 'L', '-': 'L', '*': 'L', '/': 'L', '_UNARY_MINUS': 'R'}

    def _tokenize(self, expression: str) -> list[str]:
        """
        Splits the expression string into a list of tokens (numbers and operators).
        Whitespace is ignored.
        """
        # Regex to find numbers (integers or floats) or operators.
        # Unary minus is handled in _infix_to_rpn by context.
        tokens = re.findall(r'\d+\.?\d*|[+\-*/]', expression.replace(' ', ''))
        if not tokens:
            raise CalculatorError("Empty or invalid expression.")
        return tokens

    def _infix_to_rpn(self, tokens: list[str]) -> list[str]:
        """
        Converts an infix expression (list of tokens) to Reverse Polish Notation (RPN).
        Implements the Shunting-Yard algorithm, handling unary minus.
        """
        output_queue: deque[str] = deque()
        operator_stack: deque[str] = deque()

        # Pre-process tokens to identify unary minus based on context
        processed_tokens: list[str] = []
        # Flag to determine if the current position expects an operand (number or unary minus)
        # True at the start of the expression or after an operator.
        expecting_operand = True 

        for token in tokens:
            if token == '-':
                if expecting_operand:
                    processed_tokens.append('_UNARY_MINUS')
                else:
                    processed_tokens.append(token) # Binary minus
                expecting_operand = True # After any operator, we expect an operand
            elif re.fullmatch(r'\d+\.?\d*', token):  # It's a number
                processed_tokens.append(token)
                expecting_operand = False # After a number, we expect an operator
            elif token in self.precedence: # It's a binary operator (+, *, /)
                processed_tokens.append(token)
                expecting_operand = True # After an operator, we expect an operand
            else:
                raise CalculatorError(f"Invalid token: {token}")

        # Apply Shunting-Yard algorithm to the processed tokens
        for token in processed_tokens:
            if re.fullmatch(r'\d+\.?\d*', token):  # It's a number
                output_queue.append(token)
            elif token in self.precedence:  # It's an operator (binary or unary)
                while (
                    operator_stack and operator_stack[-1] in self.precedence and
                    (
                        (self.associativity[token] == 'L' and self.precedence[token] <= self.precedence[operator_stack[-1]]) or
                        (self.associativity[token] == 'R' and self.precedence[token] < self.precedence[operator_stack[-1]])
                    )
                ):
                    output_queue.append(operator_stack.pop())
                operator_stack.append(token)
            else:
                raise CalculatorError(f"Invalid token in processed list: {token}")

        while operator_stack:
            output_queue.append(operator_stack.pop())

        return list(output_queue)

    def _evaluate_rpn(self, rpn_tokens: list[str]) -> float:
        """
        Evaluates an expression in Reverse Polish Notation (RPN).
        Handles both binary and unary operators.
        """
        operand_stack: deque[float] = deque()

        for token in rpn_tokens:
            if re.fullmatch(r'\d+\.?\d*', token):  # It's a number
                operand_stack.append(float(token))
            elif token == '_UNARY_MINUS':
                if not operand_stack:
                    raise CalculatorError("Invalid expression: not enough operands for unary minus.")
                a = operand_stack.pop()
                result = -a
                operand_stack.append(result)
            elif token in self.precedence:  # It's a binary operator
                if len(operand_stack) < 2:
                    raise CalculatorError("Invalid expression: not enough operands for operator.")
                b = operand_stack.pop()
                a = operand_stack.pop()

                if token == '+':
                    result = a + b
                elif token == '-':
                    result = a - b
                elif token == '*':
                    result = a * b
                elif token == '/':
                    if b == 0:
                        raise CalculatorError("Division by zero.")
                    result = a / b
                else:
                    raise CalculatorError(f"Unknown operator: {token}")
                operand_stack.append(result)
            else:
                raise CalculatorError(f"Invalid token in RPN: {token}")

        if len(operand_stack) != 1:
            raise CalculatorError("Invalid expression: too many operands or operators.")

        return operand_stack.pop()

    def evaluate(self, expression: str) -> float:
        """
        Main method to evaluate an infix arithmetic expression.
        """
        if not expression:
            raise CalculatorError("Expression cannot be empty.")
        tokens = self._tokenize(expression)
        rpn_tokens = self._infix_to_rpn(tokens)
        return self._evaluate_rpn(rpn_tokens)


class CalculatorApp(QMainWindow):
    """
    A minimal desktop calculator application using PySide6.
    Provides a QLineEdit display and a grid of buttons for digits and basic operators.
    """
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Calculator")
        self.setFixedSize(300, 400)

        self.general_layout = QVBoxLayout()
        self._central_widget = QWidget(self)
        self.setCentralWidget(self._central_widget)
        self._central_widget.setLayout(self.general_layout)

        self.calculator_engine = CalculatorEngine()
        self.last_was_equals: bool = False # Flag to manage state after '=' button press

        self._create_display()
        self._create_buttons()

    def _create_display(self) -> None:
        """Creates the calculator display (QLineEdit)."""
        self.display = QLineEdit()
        self.display.setFixedHeight(50)
        self.display.setAlignment(Qt.AlignmentFlag.AlignRight)
        self.display.setReadOnly(True)
        self.display.setText("0")
        font = self.display.font()
        font.setPointSize(20)
        self.display.setFont(font)
        self.general_layout.addWidget(self.display)

    def _create_buttons(self) -> None:
        """Creates the grid of calculator buttons."""
        self.buttons = {}
        buttons_layout = QGridLayout()

        # Define button text and their positions in the grid
        buttons_map = {
            'C': (0, 0), '/': (0, 3),
            '7': (1, 0), '8': (1, 1), '9': (1, 2), '*': (1, 3),
            '4': (2, 0), '5': (2, 1), '6': (2, 2), '-': (2, 3),
            '1': (3, 0), '2': (3, 1), '3': (3, 2), '+': (3, 3),
            '.': (4, 2), '=': (4, 3),
        }

        # Special handling for '0' to span two columns
        buttons_layout.addWidget(self._create_button('0'), 4, 0, 1, 2) # Row 4, Col 0, Span 1 row, 2 cols

        for btn_text, pos in buttons_map.items():
            button = self._create_button(btn_text)
            buttons_layout.addWidget(button, pos[0], pos[1])

        self.general_layout.addLayout(buttons_layout)

    def _create_button(self, text: str) -> QPushButton:
        """Helper to create a QPushButton and connect its signal."""
        button = QPushButton(text)
        button.setFixedSize(60, 60)
        font = button.font()
        font.setPointSize(15)
        button.setFont(font)
        button.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        button.clicked.connect(lambda: self._button_pressed(text))
        self.buttons[text] = button
        return button

    def _button_pressed(self, button_text: str) -> None:
        """
        Handles button press events, managing the display text based on the button pressed.
        Implements basic calculator logic for input and state management.
        """
        current_display_text = self.display.text()

        if button_text == 'C':
            self.display.setText("0")
            self.last_was_equals = False
        elif button_text == '=':
            self._calculate_result()
            self.last_was_equals = True
        elif button_text in ['+', '-', '*', '/']:
            if self.last_was_equals:
                # If last operation was '=', start new expression with result and operator
                self.display.setText(current_display_text + button_text)
            elif current_display_text == "0" and button_text == '-':
                # Special case: allow starting with '0-' for negative numbers
                self.display.setText("0-")
            elif current_display_text and current_display_text[-1] in ['+', '*', '/']:
                # If last char is a binary operator (not minus)
                if button_text == '-':
                    # Allow unary minus after another operator, e.g., "5*-"
                    self.display.setText(current_display_text + button_text)
                else:
                    # Replace previous operator with new one, e.g., "5*+" -> "5+"
                    self.display.setText(current_display_text[:-1] + button_text)
            elif current_display_text and current_display_text[-1] == '-':
                # If last char is a minus (could be binary or start of unary)
                # e.g., "5-" or "5*-"
                if button_text == '-':
                    # Disallow "5--" or "5*--" for simplicity and common calculator behavior.
                    pass # Do nothing
                else:
                    # Replace the last '-' with the new operator, e.g., "5- *" -> "5*"
                    # or "5*-+" -> "5*+"
                    self.display.setText(current_display_text[:-1] + button_text)
            else: # Last char is a digit or '.'
                self.display.setText(current_display_text + button_text)
            self.last_was_equals = False
        elif button_text == '.':
            if self.last_was_equals:
                self.display.setText("0.")
            elif current_display_text == "0":
                self.display.setText("0.")
            elif current_display_text and current_display_text[-1].isdigit():
                # Check if the current number segment already contains a decimal point
                match = re.search(r'(\d+\.?\d*)$', current_display_text)
                if match and '.' in match.group(1):
                    # Decimal already exists in the current number, do nothing
                    pass
                else:
                    self.display.setText(current_display_text + button_text)
            elif current_display_text and current_display_text[-1] in ['+', '-', '*', '/']:
                # If last char is an operator, start a new decimal number with '0.'
                self.display.setText(current_display_text + "0.")
            self.last_was_equals = False
        else: # Digits (0-9)
            if self.last_was_equals or current_display_text == "0":
                self.display.setText(button_text)
            else:
                self.display.setText(current_display_text + button_text)
            self.last_was_equals = False

    def _calculate_result(self) -> None:
        """
        Evaluates the expression currently in the display and updates the display
        with the result or an error message.
        """
        expression = self.display.text()
        try:
            result = self.calculator_engine.evaluate(expression)
            # Format result to avoid excessive decimal places for integers
            if result == int(result):
                self.display.setText(str(int(result)))
            else:
                self.display.setText(str(result))
        except CalculatorError as e:
            self.display.setText(f"Error: {e}")
        except Exception:
            self.display.setText("Error")


if __name__ == "__main__":
    app = QApplication(sys.argv)
    calc = CalculatorApp()
    calc.show()
    sys.exit(app.exec())
