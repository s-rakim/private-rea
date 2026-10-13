//! A one-line progress bar on stderr (only when stderr is a terminal).

use std::io::{IsTerminal, Write};
use std::time::{Duration, Instant};

pub struct Progress {
    label: String,
    total: u64,
    start: Instant,
    last_draw: Option<Instant>,
    tty: bool,
    quiet: bool,
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

impl Progress {
    pub fn new(label: impl Into<String>, total: u64, quiet: bool) -> Self {
        Progress {
            label: label.into(),
            total,
            start: Instant::now(),
            last_draw: None,
            tty: std::io::stderr().is_terminal(),
            quiet,
        }
    }

    pub fn update(&mut self, done: u64) {
        if self.quiet || !self.tty {
            return;
        }
        let now = Instant::now();
        if self.last_draw.is_some_and(|t| now - t < Duration::from_millis(100)) && done < self.total {
            return;
        }
        self.last_draw = Some(now);
        let pct = done.saturating_mul(100).checked_div(self.total).map_or(100, |p| p.min(100));
        let width = 24;
        let filled = (pct as usize * width) / 100;
        let bar = format!("{}{}", "#".repeat(filled), "-".repeat(width - filled));
        let mut line = format!(
            "\r{}  [{bar}] {pct:>3}%  {}/{}  {}/s",
            self.label,
            human_bytes(done),
            human_bytes(self.total),
            human_bytes(self.rate(done))
        );
        line.push_str("\x1b[K");
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(line.as_bytes());
        let _ = err.flush();
    }

    fn rate(&self, done: u64) -> u64 {
        let secs = self.start.elapsed().as_secs_f64();
        if secs < 0.001 {
            0
        } else {
            (done as f64 / secs) as u64
        }
    }

    /// Clear the bar and print a summary line.
    pub fn finish(&mut self, verb: &str) {
        if self.quiet {
            return;
        }
        let secs = self.start.elapsed().as_secs_f64();
        let clear = if self.tty { "\r\x1b[K" } else { "" };
        eprintln!(
            "{clear}{verb} {} ({}, {:.1}s, {}/s)",
            self.label,
            human_bytes(self.total),
            secs,
            human_bytes(self.rate(self.total))
        );
    }

    /// Clear the bar without a summary (on failure).
    pub fn abandon(&mut self) {
        if !self.quiet && self.tty && self.last_draw.is_some() {
            eprint!("\r\x1b[K");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::human_bytes;

    #[test]
    fn sizes() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1536), "1.5 KiB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MiB");
    }
}
