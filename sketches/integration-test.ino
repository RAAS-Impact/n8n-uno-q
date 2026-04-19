/**
 * integration-test.ino — MCU sketch for end-to-end validation of the Bridge package.
 *
 * Exposes multiple methods to exercise different RPC patterns:
 * - set_led_state(bool)   → write, returns null
 * - get_led_state()       → read, returns bool
 * - add(a, b)             → returns a + b (typed params test)
 * - ping()                → returns "pong" (simplest call)
 *
 * Also sends a "heartbeat" NOTIFY every 5 seconds and flashes the
 * Arduino logo on the 8x13 LED matrix for 1 second at each heartbeat.
 *
 * Flash this sketch via App Lab before running the Node.js test script.
 */
#include <Arduino_LED_Matrix.h>
#include <Arduino_RouterBridge.h>
Arduino_LED_Matrix matrix;

#include <array>
bool ledState = false;
unsigned long lastHeartbeat = 0;
std::array<bool, 3> rgbState = {false, false, false};

// Input pin that the interruption will be attached to
const byte interruptPin = 2;
// Interrupt simulation flag — set by ISR (or fire_test_event), drained in
// loop(). Never call Bridge.notify() directly from an ISR.
volatile bool interruptFired = false;
const unsigned long HEARTBEAT_INTERVAL = 5000; // ms

uint8_t LOGO[104] = {
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 3, 3, 3, 0, 3, 3, 3, 0, 0, 0,
  0, 0, 0, 3, 0, 3, 0, 0, 3, 0, 0, 0, 0,
  0, 0, 0, 3, 3, 0, 0, 0, 3, 0, 0, 0, 0,
  0, 0, 0, 3, 0, 3, 0, 3, 3, 3, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
};


// Track when to clear the matrix after showing the logo
unsigned long logoClearTime = 0;
bool logoShowing = false;

// --- Method handlers ---

void set_led_state(bool state) {
  ledState = state;
  digitalWrite(LED_BUILTIN, state ? LOW : HIGH);
}

bool get_led_state() { return ledState; }

void set_rgb_state(std::array<bool, 3> state) {
  rgbState = state;
  digitalWrite(LED4_R, state[0] ? LOW : HIGH);
  digitalWrite(LED4_G, state[1] ? LOW : HIGH);
  digitalWrite(LED4_B, state[2] ? LOW : HIGH);
}

std::array<bool, 3> get_rgb_state() { return rgbState; }

int add(int a, int b) { return a + b; }

String ping() { return "pong"; }

// Software trigger for testing the interrupt→notify path without hardware.
// Sets the same flag a real ISR would set; loop() drains it and fires the
// NOTIFY.
void fire_test_event() { interruptFired = true; }

// --- Setup & Loop ---

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // off (active low)

  // Configure the pins as outputs
  pinMode(LED4_R, OUTPUT);
  pinMode(LED4_G, OUTPUT);
  pinMode(LED4_B, OUTPUT);
  // As they are active low, turn them OFF initially
  digitalWrite(LED4_R, HIGH);
  digitalWrite(LED4_G, HIGH);
  digitalWrite(LED4_B, HIGH);

  pinMode(interruptPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(interruptPin), fire_test_event, CHANGE);

  matrix.begin();
  matrix.clear();

  Bridge.begin();

  Bridge.provide("set_led_state", set_led_state);
  Bridge.provide("get_led_state", get_led_state);
  Bridge.provide("set_rgb_state", set_rgb_state);
  Bridge.provide("get_rgb_state", get_rgb_state);
  Bridge.provide("add", add);
  Bridge.provide("ping", ping);
  Bridge.provide("fire_test_event", fire_test_event);
}

void loop() {
  unsigned long now = millis();

  // Drain interrupt flag — safe to call Bridge.notify() here (not in ISR)
  if (interruptFired) {
    interruptFired = false;
    Bridge.call("gpio_event", 2); // pin 2 simulated
    set_led_state(!ledState);
  }

  // Heartbeat every 5 seconds: notify + show Arduino logo
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
    lastHeartbeat = now;
    Bridge.notify("heartbeat", (int)(now / 1000));

    // Show Arduino logo on the LED matrix
    matrix.draw(LOGO);
    logoShowing = true;
    logoClearTime = now + 1000; // show for 1 second
  }

  // Clear the logo after 1 second
  if (logoShowing && now >= logoClearTime) {
    matrix.clear();
    logoShowing = false;
  }
}
