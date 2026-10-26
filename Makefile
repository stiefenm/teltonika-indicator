UUID := teltonika-indicator@mstiefenhofer
EXTRA := lib
DATA_HOME ?= $(or $(XDG_DATA_HOME),$(HOME)/.local/share)
DESKTOP := $(DATA_HOME)/applications/teltonika-indicator.desktop
ICON := $(DATA_HOME)/icons/hicolor/scalable/apps/teltonika-indicator.svg

.PHONY: all pack install uninstall test schemas pot po clean

all: pack

schemas:
	glib-compile-schemas --strict schemas/

pack:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --podir=po \
		$(foreach f,$(EXTRA),--extra-source=$(f)) .

# Vorlage aus dem Quelltext neu erzeugen und in die Übersetzungen einpflegen
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
		--add-comments=Translators: --package-name=teltonika-indicator \
		--msgid-bugs-address=https://github.com/stiefenm/teltonika-indicator/issues \
		--files-from=po/POTFILES --output=po/teltonika-indicator.pot

po: pot
	for f in po/*.po; do msgmerge --update --backup=none $$f po/teltonika-indicator.pot; done

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
