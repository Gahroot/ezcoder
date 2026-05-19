# ez_pixel (Ruby)

Ruby SDK for ez-pixel error tracking. Same wire format as the JS, Python,
Go, Rust, Swift, and Workers SDKs.

## Install

```bash
gem install ez_pixel
```

Or in a Gemfile:

```ruby
gem "ez_pixel"
```

## Use

```ruby
require "ez_pixel"

EZPixel.init(project_key: ENV["EZCODER_PIXEL_KEY"])

# Anything uncaught after this point is reported on exit.

begin
  risky!
rescue => e
  EZPixel.capture_exception(e)
end

EZPixel.report("user clicked the broken button")
```

`init` installs an `at_exit` hook that captures any unhandled exception
that propagated out of the program — so a true uncaught error lands in
your ez-pixel queue before the process exits.
