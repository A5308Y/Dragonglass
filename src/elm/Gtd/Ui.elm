module Gtd.Ui exposing
    ( Key(..)
    , boolAttribute
    , issuesView
    , iconLabel
    , keyDecoder
    , labelled
    , matches
    , maybeList
    , maybeView
    , onEnter
    , onKeyDown
    , onModEnter
    , onPointer
    , plural
    , preventDefaultOn
    , preventMouseDown
    , timer
    , srOnly
    , uniqueSorted
    )

{-| View helpers every Dragonglass surface shares.

Keyboard handling goes through `Key` rather than raw event strings, so a view
matches on the keys it actually handles and the compiler lists the rest.

-}

import Gtd.Data exposing (Issue)
import Html exposing (Html, div, label, span, text)
import Html.Attributes exposing (attribute, class, id, title)
import Html.Events exposing (custom, on)
import Json.Decode as Decode exposing (Decoder)
import Set


{-| The keys Dragonglass acts on. Everything else is `OtherKey`.
-}
type Key
    = ArrowDown
    | ArrowUp
    | Enter
    | Escape
    | Backspace
    | Delete
    | Character String
    | OtherKey


keyDecoder : Decoder Key
keyDecoder =
    Decode.field "key" Decode.string |> Decode.map fromEventKey


fromEventKey : String -> Key
fromEventKey raw =
    case raw of
        "ArrowDown" ->
            ArrowDown

        "ArrowUp" ->
            ArrowUp

        "Enter" ->
            Enter

        "Escape" ->
            Escape

        "Backspace" ->
            Backspace

        "Delete" ->
            Delete

        _ ->
            if String.length raw == 1 then
                Character (String.toLower raw)

            else
                OtherKey


onKeyDown : (Key -> msg) -> Html.Attribute msg
onKeyDown toMessage =
    on "keydown" (Decode.map toMessage keyDecoder)


{-| Runs a message on Enter and leaves every other key alone.
-}
onEnter : { enter : msg, ignore : msg } -> Html.Attribute msg
onEnter handlers =
    on "keydown"
        (Decode.map
            (\key ->
                if key == Enter then
                    handlers.enter

                else
                    handlers.ignore
            )
            keyDecoder
        )


{-| ⌘/Ctrl+Enter, the chord that saves a multi-line field without leaving it.
-}
onModEnter : { save : msg, ignore : msg } -> Html.Attribute msg
onModEnter handlers =
    custom "keydown"
        (Decode.map3
            (\key meta ctrl ->
                let
                    submit =
                        key == Enter && (meta || ctrl)
                in
                { message =
                    if submit then
                        handlers.save

                    else
                        handlers.ignore
                , stopPropagation = submit
                , preventDefault = submit
                }
            )
            keyDecoder
            (Decode.field "metaKey" Decode.bool)
            (Decode.field "ctrlKey" Decode.bool)
        )


preventDefaultOn : String -> msg -> Html.Attribute msg
preventDefaultOn eventName message =
    custom eventName (Decode.succeed { message = message, stopPropagation = False, preventDefault = True })


{-| Keeps a click on a suggestion from blurring the input before the choice lands.
-}
preventMouseDown : msg -> Html.Attribute msg
preventMouseDown message =
    custom "mousedown" (Decode.succeed { message = message, stopPropagation = False, preventDefault = True })


{-| A click that reports where it happened, so the host can place a menu there.
-}
onPointer : (Float -> Float -> msg) -> Html.Attribute msg
onPointer toMessage =
    custom "click"
        (Decode.map2
            (\x y -> { message = toMessage x y, stopPropagation = True, preventDefault = True })
            (Decode.field "clientX" Decode.float)
            (Decode.field "clientY" Decode.float)
        )


{-| A case-insensitive substring match against any of a row's searchable fields.
-}
matches : String -> List String -> Bool
matches query candidates =
    let
        needle =
            String.toLower (String.trim query)
    in
    String.isEmpty needle || List.any (String.toLower >> String.contains needle) candidates


uniqueSorted : List String -> List String
uniqueSorted values =
    values |> Set.fromList |> Set.toList |> List.sort


maybeView : Maybe a -> (a -> Html msg) -> Html msg
maybeView maybeValue render =
    Maybe.map render maybeValue |> Maybe.withDefault (text "")


maybeList : Maybe a -> (a -> b) -> List b
maybeList maybeValue render =
    Maybe.map (render >> List.singleton) maybeValue |> Maybe.withDefault []


boolAttribute : Bool -> String
boolAttribute value =
    if value then
        "true"

    else
        "false"


plural : Int -> String -> String
plural count noun =
    String.fromInt count
        ++ " "
        ++ noun
        ++ (if count == 1 then
                ""

            else
                "s"
           )


{-| `m:ss`, with a leading minus once a budget has been overrun.
-}
timer : Int -> String
timer seconds =
    let
        absolute =
            abs seconds
    in
    (if seconds < 0 then
        "−"

     else
        ""
    )
        ++ String.fromInt (absolute // 60)
        ++ ":"
        ++ String.padLeft 2 '0' (String.fromInt (modBy 60 absolute))


{-| Files whose GTD metadata could not be read, and why. Collapsed to a count; opened,
each file is listed with its problem and opens on a tap, so it can be fixed there.
-}
issuesView : (String -> msg) -> List Issue -> Html msg
issuesView openFile issues =
    if List.isEmpty issues then
        text ""

    else
        Html.node "details"
            [ class "dg-warning dg-issues" ]
            [ Html.node "summary"
                []
                [ text
                    (String.fromInt (List.length issues)
                        ++ (if List.length issues == 1 then
                                " GTD file has a metadata problem."

                            else
                                " GTD files have metadata problems."
                           )
                        ++ " Show which"
                    )
                ]
            , Html.ul [ class "dg-issues-list" ]
                (List.map
                    (\issue ->
                        Html.li []
                            [ Html.button [ class "dg-issue-file dg-flat-button", Html.Events.onClick (openFile issue.path) ] [ text issue.path ]
                            , span [ class "dg-issue-message" ] [ text issue.message ]
                            ]
                    )
                    (List.sortBy .path issues)
                )
            ]


{-| Text only screen readers see. Obsidian turns every `aria-label` into a hover
tooltip, so accessible names are given as hidden text instead.
-}
srOnly : String -> Html msg
srOnly name =
    span [ class "dg-sr-only" ] [ text name ]


{-| The content of an icon-only button: the icon, hidden from screen readers,
and its name, hidden from sight.
-}
iconLabel : String -> String -> List (Html msg)
iconLabel icon name =
    [ span [ attribute "aria-hidden" "true" ] [ text icon ], srOnly name ]


{-| Names a control that has no visible label of its own, without a tooltip. The
wrapping label takes no space in the layout.
-}
labelled : String -> Html msg -> Html msg
labelled name control =
    label [ class "dg-labelled" ] [ srOnly name, control ]
