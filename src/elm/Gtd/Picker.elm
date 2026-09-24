module Gtd.Picker exposing
    ( Config
    , Picker
    , PickerMsg(..)
    , choose
    , config
    , init
    , isResolved
    , query
    , selection
    , update
    , view
    )

{-| The fuzzy field Dragonglass uses wherever a Project, a context, or a vault
image is typed or chosen.

The picker keeps the typed text and the resolved choice apart, so a form can tell
"nothing selected" from "something typed that matched nothing" and refuse to save
the second.

-}

import Gtd.Ui as Ui exposing (Key(..))
import Html exposing (Html, button, div, input, small, span, text)
import Html.Attributes exposing (attribute, class, classList, placeholder, tabindex, type_, value)
import Html.Events exposing (custom, onBlur, onFocus, onInput, onMouseEnter)
import Json.Decode as Decode


type alias Picker value =
    { query : String
    , selection : Maybe value
    , open : Bool
    , activeIndex : Int
    }


type alias Config value msg =
    { placeholder : String
    , label : value -> String
    , hint : value -> Maybe String
    , changed : String -> msg
    , chosen : value -> msg
    , focused : Bool -> msg
    , keyed : Key -> msg
    , hovered : Int -> msg
    }


init : String -> Maybe value -> Picker value
init typed chosen =
    { query = typed, selection = chosen, open = False, activeIndex = 0 }


query : Picker value -> String
query picker =
    String.trim picker.query


selection : Picker value -> Maybe value
selection picker =
    picker.selection


{-| True unless text was typed that never resolved to a choice.
-}
isResolved : Picker value -> Bool
isResolved picker =
    picker.selection /= Nothing || String.isEmpty (query picker)


{-| Everything that can happen to a picker field.
-}
type PickerMsg value
    = Typed String
    | Chose value
    | Focused Bool
    | Keyed Key
    | Hovered Int


{-| Applies one event, given the suggestions currently on screen.
-}
update : PickerMsg value -> List value -> (value -> String) -> Picker value -> Picker value
update msg suggestions toLabel picker =
    case msg of
        Typed typed ->
            setQuery typed picker

        Chose chosen ->
            choose (toLabel chosen) chosen picker

        Focused open ->
            setOpen open picker

        Keyed key ->
            onKey key suggestions toLabel picker

        Hovered index ->
            { picker | activeIndex = index }


{-| Wires a picker's events to one message constructor.
-}
config :
    { placeholder : String
    , label : value -> String
    , hint : value -> Maybe String
    , tag : PickerMsg value -> msg
    }
    -> Config value msg
config fields =
    { placeholder = fields.placeholder
    , label = fields.label
    , hint = fields.hint
    , changed = Typed >> fields.tag
    , chosen = Chose >> fields.tag
    , focused = Focused >> fields.tag
    , keyed = Keyed >> fields.tag
    , hovered = Hovered >> fields.tag
    }


{-| Typing always clears the resolved choice: the text no longer describes it.
-}
setQuery : String -> Picker value -> Picker value
setQuery typed picker =
    { picker | query = typed, selection = Nothing, open = True, activeIndex = 0 }


choose : String -> value -> Picker value -> Picker value
choose label chosen picker =
    { picker | query = label, selection = Just chosen, open = False, activeIndex = 0 }


setOpen : Bool -> Picker value -> Picker value
setOpen open picker =
    { picker | open = open }


onKey : Key -> List value -> (value -> String) -> Picker value -> Picker value
onKey key suggestions toLabel picker =
    let
        count =
            List.length suggestions

        step direction =
            if count == 0 then
                0

            else
                modBy count (picker.activeIndex + direction)
    in
    case key of
        Escape ->
            { picker | open = False }

        ArrowDown ->
            { picker | open = True, activeIndex = step 1 }

        ArrowUp ->
            { picker | open = True, activeIndex = step -1 }

        Enter ->
            if picker.open then
                case List.drop picker.activeIndex suggestions |> List.head of
                    Just candidate ->
                        choose (toLabel candidate) candidate picker

                    Nothing ->
                        picker

            else
                picker

        Character _ ->
            picker

        Backspace ->
            picker

        Delete ->
            picker

        OtherKey ->
            picker


view : Config value msg -> List value -> Picker value -> Html msg
view settings suggestions picker =
    div [ class "dg-fuzzy-field" ]
        [ Ui.labelled (String.replace "…" "" settings.placeholder) <|
            input
            [ value picker.query
            , placeholder settings.placeholder
            , attribute "role" "combobox"
            , attribute "aria-autocomplete" "list"
            , attribute "aria-expanded" (Ui.boolAttribute (picker.open && not (List.isEmpty suggestions)))
            , attribute "autocomplete" "off"
            , type_ "text"
            , onFocus (settings.focused True)
            , onBlur (settings.focused False)
            , onInput settings.changed
            , keydown picker.open settings.keyed
            ]
            []
        , if not picker.open || List.isEmpty suggestions then
            text ""

          else
            div [ class "dg-fuzzy-results", attribute "role" "listbox" ]
                (List.indexedMap (suggestionView settings picker.activeIndex) suggestions)
        ]


suggestionView : Config value msg -> Int -> Int -> value -> Html msg
suggestionView settings activeIndex index candidate =
    button
        [ type_ "button"
        -- Out of the tab order: suggestions are chosen with the arrows and Enter, so Tab
        -- leaves the field for the next one instead of landing on a suggestion that
        -- vanishes as soon as the field loses focus.
        , tabindex -1
        , attribute "role" "option"
        , attribute "aria-selected" (Ui.boolAttribute (index == activeIndex))
        , classList [ ( "dg-flat-button", True ), ( "is-active", index == activeIndex ) ]
        , onMouseEnter (settings.hovered index)
        , Ui.preventMouseDown (settings.chosen candidate)
        ]
        [ span [] [ text (settings.label candidate) ]
        , Ui.maybeView (settings.hint candidate) (\hint -> small [] [ text hint ])
        ]


{-| Arrow keys and Enter belong to the open suggestion list, not to the form.
-}
keydown : Bool -> (Key -> msg) -> Html.Attribute msg
keydown open toMessage =
    custom "keydown"
        (Decode.map
            (\key ->
                { message = toMessage key
                , stopPropagation = False
                , preventDefault = open && List.member key [ ArrowDown, ArrowUp, Enter ]
                }
            )
            Ui.keyDecoder
        )
