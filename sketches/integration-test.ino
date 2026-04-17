/**
 * bridge-test.ino — MCU sketch for end-to-end validation of the Bridge package.
 *
 * Flash this via App Lab before running either of:
 *   - experiments/test-bridge.mjs  (manual end-to-end smoke test)
 *   - packages/bridge test:integration  (Vitest integration suite)
 *
 * Exposes multiple methods to exercise different RPC patterns:
 *   - ping()                  → returns "pong"
 *   - add(a, b)               → returns a + b
 *   - set_led_state(bool)     → drives LED_BUILTIN, returns null
 *   - get_led_state()         → returns current LED state as bool
 *   - fire_test_event()       → sets interruptFired flag; loop() fires gpio_event NOTIFY
 *
 * Sends a "heartbeat" NOTIFY every 5 seconds and flashes the Arduino logo
 * on the 8x13 LED matrix for 1 second at each heartbeat.
 */
#include <Arduino_LED_Matrix.h>
#include <Arduino_RouterBridge.h>
Arduino_LED_Matrix matrix;

bool ledState = false;
unsigned long lastHeartbeat = 0;

// Interrupt simulation flag — set by ISR (or fire_test_event), drained in loop().
// Never call Bridge.notify() directly from an ISR.
volatile bool interruptFired = false;
const unsigned long HEARTBEAT_INTERVAL = 5000; // ms

// Arduino symbols (− and +) for the 8x13 LED matrix.
// Minus on the left, plus on the right — the two iconic Arduino symbols.
// 104 bits packed into 4 x uint32_t. Row-major, MSB first.
//
//   col: 0 1 2 3 4 5 6 7 8 9 10 11 12
//   r0:  . . . . . . . . .  .  .  .  .
//   r1:  . . . . . . . . .  .  #  .  .
//   r2:  . . . . . . . . .  .  #  .  .
//   r3:  . . # # # . . . #  #  #  #  #
//   r4:  . . # # # . . . #  #  #  #  #
//   r5:  . . . . . . . . .  .  #  .  .
//   r6:  . . . . . . . . .  .  #  .  .
//   r7:  . . . . . . . . .  .  .  .  .
//
const uint32_t MINUS_PLUS[] = {0x00000100, 0x0871F38F, 0x80100080, 0x00000000};

// Track when to clear the matrix after showing the logo
unsigned long logoClearTime = 0;
bool logoShowing = false;

// --- Method handlers ---

void set_led_state(bool state) {
  ledState = state;
  digitalWrite(LED_BUILTIN, state ? LOW : HIGH);
}

bool get_led_state() { return ledState; }

int add(int a, int b) { return a + b; }

String ping() { return "pong"; }

// Software trigger for testing the interrupt→notify path without hardware.
// Sets the same flag a real ISR would set; loop() drains it and fires the NOTIFY.
void fire_test_event() { interruptFired = true; }

// --- Setup & Loop ---

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // off (active low)

  matrix.begin();
  matrix.clear();

  Bridge.begin();

  Bridge.provide("set_led_state", set_led_state);
  Bridge.provide("get_led_state", get_led_state);
  Bridge.provide("add", add);
  Bridge.provide("ping", ping);
  Bridge.provide("fire_test_event", fire_test_event);
}

void loop() {
  unsigned long now = millis();

  // Drain interrupt flag — safe to call Bridge.notify() here (not in ISR)
  if (interruptFired) {
    interruptFired = false;
    Bridge.notify("gpio_event", 2); // pin 2 simulated
  }

  // Heartbeat every 5 seconds: notify + show Arduino logo
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
    lastHeartbeat = now;
    Bridge.notify("heartbeat", (int)(now / 1000));

    // Show Arduino logo on the LED matrix
    matrix.loadFrame(MINUS_PLUS);
    logoShowing = true;
    logoClearTime = now + 1000; // show for 1 second
  }

  // Clear the logo after 1 second
  if (logoShowing && now >= logoClearTime) {
    matrix.clear();
    logoShowing = false;
  }
}
