module Gtd.Checklist exposing
    ( Block(..)
    , Counts
    , MarkState(..)
    , Run
    , counts
    , encodeMarkState
    , itemCount
    , itemsView
    , markOf
    , runDecoder
    )

{-| A checklist run as the host reports it, and the item list the Checklists and
Pomodoro views both show.

The note is the template and is never written: ticking an item marks it in the
run. The Markdown between items is rendered by Obsidian, so links in and between
items open as they would in the note.

-}

import Dict exposing (Dict)
import Gtd.Ui as Ui
import Html exposing (Html, button, div, input, li, node, span, text, ul)
import Html.Attributes exposing (attribute, checked, class, classList, id, style, type_)
import Html.Events exposing (onCheck, onClick)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


type MarkState
    = Done
    | Skipped
    | Open


type Block
    = Markdown String
    | Item { key : String, text : String, depth : Int }


type alias Run =
    { id : String
    , path : String
    , title : String
    , startedDay : String
    , startedTime : String
    , finished : Bool
    , blocks : List Block
    , noteMissing : Bool
    , marks : Dict String MarkState
    , removed : List { key : String, text : String, state : MarkState }
    , repeatedlySkipped : List String
    }


type alias Counts =
    { done : Int, skipped : Int, open : Int }


markOf : Run -> String -> MarkState
markOf run key =
    Dict.get key run.marks |> Maybe.withDefault Open


items : Run -> List { key : String, text : String, depth : Int }
items run =
    List.filterMap
        (\block ->
            case block of
                Item item ->
                    Just item

                Markdown _ ->
                    Nothing
        )
        run.blocks


itemCount : Run -> Int
itemCount run =
    List.length (items run)


{-| How the note's current items stand in the run.
-}
counts : Run -> Counts
counts run =
    List.foldl
        (\item total ->
            case markOf run item.key of
                Done ->
                    { total | done = total.done + 1 }

                Skipped ->
                    { total | skipped = total.skipped + 1 }

                Open ->
                    { total | open = total.open + 1 }
        )
        { done = 0, skipped = 0, open = 0 }
        (items run)



-- VIEW


type alias Config msg =
    { mark : String -> MarkState -> msg

    -- Captures what an item turned up to the Inbox; `Nothing` leaves the button out.
    , capture : Maybe (String -> msg)
    , readOnly : Bool
    }


{-| The note in order: Markdown between the items, and each item with a tick box
and a Skip toggle for items that don't apply this time.
-}
itemsView : Config msg -> Run -> Html msg
itemsView config run =
    div [ class "dg-checklist-items" ]
        (List.indexedMap (blockView config run) run.blocks
            ++ [ removedView run ]
        )


blockView : Config msg -> Run -> Int -> Block -> Html msg
blockView config run index block =
    case block of
        Markdown markdown ->
            markdownView [ class "dg-checklist-markdown" ] run.path markdown

        Item item ->
            let
                state =
                    markOf run item.key

                textId =
                    "dg-checklist-item-" ++ run.id ++ "-" ++ String.fromInt index
            in
            div
                [ classList
                    [ ( "dg-checklist-item", True )
                    , ( "is-done", state == Done )
                    , ( "is-skipped", state == Skipped )
                    ]
                , style "--dg-checklist-depth" (String.fromInt item.depth)
                ]
                [ input
                    [ type_ "checkbox"
                    , checked (state == Done)
                    , Html.Attributes.disabled (config.readOnly || state == Skipped)
                    , attribute "aria-labelledby" textId
                    , onCheck
                        (\on ->
                            config.mark item.key
                                (if on then
                                    Done

                                 else
                                    Open
                                )
                        )
                    ]
                    []
                , markdownView [ id textId, class "dg-checklist-item-text" ] run.path item.text
                , if state == Skipped then
                    span [ class "dg-checklist-skipped" ] [ text "Skipped" ]

                  else
                    text ""
                , if config.readOnly then
                    text ""

                  else
                    div [ class "dg-checklist-item-actions" ]
                        [ button
                            [ class "dg-flat-button dg-checklist-skip"
                            , attribute "aria-pressed" (Ui.boolAttribute (state == Skipped))
                            , onClick
                                (config.mark item.key
                                    (if state == Skipped then
                                        Open

                                     else
                                        Skipped
                                    )
                                )
                            ]
                            (if state == Skipped then
                                Ui.iconLabel "Undo skip" ("Undo skipping " ++ item.text)

                             else
                                Ui.iconLabel "Skip" ("Skip " ++ item.text ++ " this time")
                            )
                        , case config.capture of
                            Just capture ->
                                button [ class "dg-flat-button dg-checklist-capture", onClick (capture item.text) ]
                                    (Ui.iconLabel "→ Inbox" ("Capture something about " ++ item.text ++ " to the Inbox"))

                            Nothing ->
                                text ""
                        ]
                ]


{-| Marks on items that were taken out of the note since the run began.
-}
removedView : Run -> Html msg
removedView run =
    if List.isEmpty run.removed then
        text ""

    else
        div [ class "dg-checklist-removed" ]
            [ span [ class "dg-checklist-removed-label" ] [ text "No longer in the checklist" ]
            , ul []
                (List.map
                    (\item ->
                        li []
                            [ markdownView [ class "dg-checklist-item-text" ] run.path item.text
                            , span [ class "dg-muted" ]
                                [ text
                                    (if item.state == Skipped then
                                        " (skipped)"

                                     else
                                        " (done)"
                                    )
                                ]
                            ]
                    )
                    run.removed
                )
            ]


markdownView : List (Html.Attribute msg) -> String -> String -> Html msg
markdownView attributes sourcePath markdown =
    node "dg-markdown"
        (attributes
            ++ [ class "markdown-rendered"
               , attribute "data-markdown" markdown
               , attribute "data-source-path" sourcePath
               ]
        )
        []



-- DECODING


runDecoder : Decoder Run
runDecoder =
    Decode.succeed Run
        |> andMap (Decode.field "id" Decode.string)
        |> andMap (Decode.field "path" Decode.string)
        |> andMap (Decode.field "title" Decode.string)
        |> andMap (Decode.field "startedDay" Decode.string)
        |> andMap (Decode.field "startedTime" Decode.string)
        |> andMap (Decode.field "finished" Decode.bool)
        |> andMap (Decode.field "blocks" (Decode.list blockDecoder))
        |> andMap (Decode.field "noteMissing" Decode.bool)
        |> andMap
            (Decode.field "marks"
                (Decode.list (Decode.map2 Tuple.pair (Decode.field "key" Decode.string) (Decode.field "state" markStateDecoder)))
                |> Decode.map Dict.fromList
            )
        |> andMap
            (Decode.field "removed"
                (Decode.list
                    (Decode.map3 (\key itemText state -> { key = key, text = itemText, state = state })
                        (Decode.field "key" Decode.string)
                        (Decode.field "text" Decode.string)
                        (Decode.field "state" markStateDecoder)
                    )
                )
            )
        |> andMap (Decode.field "repeatedlySkipped" (Decode.list Decode.string))


blockDecoder : Decoder Block
blockDecoder =
    Decode.field "kind" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "markdown" ->
                        Decode.map Markdown (Decode.field "markdown" Decode.string)

                    "item" ->
                        Decode.map3 (\key itemText depth -> Item { key = key, text = itemText, depth = depth })
                            (Decode.field "key" Decode.string)
                            (Decode.field "text" Decode.string)
                            (Decode.field "depth" Decode.int)

                    _ ->
                        Decode.fail ("Unknown checklist block: " ++ kind)
            )


markStateDecoder : Decoder MarkState
markStateDecoder =
    Decode.string
        |> Decode.andThen
            (\state ->
                case state of
                    "done" ->
                        Decode.succeed Done

                    "skipped" ->
                        Decode.succeed Skipped

                    "open" ->
                        Decode.succeed Open

                    _ ->
                        Decode.fail ("Unknown mark: " ++ state)
            )


encodeMarkState : MarkState -> Encode.Value
encodeMarkState state =
    Encode.string
        (case state of
            Done ->
                "done"

            Skipped ->
                "skipped"

            Open ->
                "open"
        )


andMap : Decoder a -> Decoder (a -> b) -> Decoder b
andMap =
    Decode.map2 (|>)
