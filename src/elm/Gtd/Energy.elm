module Gtd.Energy exposing
    ( Energy(..)
    , all
    , badge
    , decoder
    , fromKey
    , key
    , label
    , symbol
    )

{-| How much energy an Action takes when it is out of the ordinary. Most Actions
carry no level, which reads as normal energy.
-}

import Html exposing (Html, span, text)
import Html.Attributes exposing (attribute, class)
import Json.Decode as Decode exposing (Decoder)


type Energy
    = Low
    | High


all : List Energy
all =
    [ Low, High ]


key : Energy -> String
key energy =
    case energy of
        Low ->
            "low"

        High ->
            "high"


label : Energy -> String
label energy =
    case energy of
        Low ->
            "Low"

        High ->
            "High"


{-| One emoji per level that reads on its own: an empty battery and a lightning bolt.
-}
symbol : Energy -> String
symbol energy =
    case energy of
        Low ->
            "🪫"

        High ->
            "⚡"


fromKey : String -> Maybe Energy
fromKey raw =
    List.filter (\energy -> key energy == raw) all |> List.head


{-| The symbol shown on an Action card, named for screen readers.
-}
badge : Energy -> Html msg
badge energy =
    span [ class ("dg-energy dg-energy-" ++ key energy) ]
        [ span [ attribute "aria-hidden" "true" ] [ text (symbol energy) ]
        -- `Gtd.Ui.srOnly`, which this module cannot import: `Gtd.Ui` depends on `Gtd.Data`.
        , span [ class "dg-sr-only" ] [ text (label energy ++ " energy") ]
        ]


decoder : Decoder Energy
decoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case fromKey raw of
                    Just energy ->
                        Decode.succeed energy

                    Nothing ->
                        Decode.fail ("Unknown energy: " ++ raw)
            )
