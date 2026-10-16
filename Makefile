UUID := teltonika-indicator@mstiefenhofer
EXTRA := lib

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
	@echo "Unter Wayland: ab- und wieder anmelden, dann: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

test:
	test/run.sh

clean:
	rm -rf dist schemas/gschemas.compiled
