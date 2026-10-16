UUID := teltonika-indicator@mstiefenhofer
EXTRA := lib
DATA_HOME ?= $(or $(XDG_DATA_HOME),$(HOME)/.local/share)
DESKTOP := $(DATA_HOME)/applications/teltonika-indicator.desktop
ICON := $(DATA_HOME)/icons/hicolor/scalable/apps/teltonika-indicator.svg

.PHONY: all pack install uninstall test schemas clean

all: pack

schemas:
	glib-compile-schemas --strict schemas/

pack:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		$(foreach f,$(EXTRA),--extra-source=$(f)) .

install: pack
	gnome-extensions install --force dist/$(UUID).shell-extension.zip
	install -Dm644 data/teltonika-indicator.desktop $(DESKTOP)
	install -Dm644 data/teltonika-indicator.svg $(ICON)
	@echo "Unter Wayland: ab- und wieder anmelden, dann: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)
	rm -f $(DESKTOP) $(ICON)

test:
	test/run.sh

clean:
	rm -rf dist schemas/gschemas.compiled
