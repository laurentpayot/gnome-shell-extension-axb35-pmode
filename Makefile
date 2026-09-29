UUID := axb35-pmode@laurentpayot.github.io
ZIP := $(UUID).shell-extension.zip
SOURCES := extension.js metadata.json stylesheet.css \
	schemas/org.gnome.shell.extensions.axb35-pmode.gschema.xml

.PHONY: pack
pack: $(ZIP)

$(ZIP): $(SOURCES)
	gnome-extensions pack --force .

# GNOME Shell only picks up a new extension at the next login.
.PHONY: install
install: $(ZIP)
	gnome-extensions install --force $(ZIP)

.PHONY: uninstall
uninstall:
	gnome-extensions uninstall $(UUID)

# Static analysis run by extensions.gnome.org on every upload
# (pip install shexli).
.PHONY: lint
lint: $(ZIP)
	shexli $(ZIP)

.PHONY: clean
clean:
	rm -f $(ZIP) schemas/gschemas.compiled
